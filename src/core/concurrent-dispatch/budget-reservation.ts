// src/core/concurrent-dispatch/budget-reservation.ts
//
// Budget reservation ledger for concurrent subagent dispatch. PR 3 of 6 of
// the v7.11.0 concurrent subagent execution spec — the budget half of the
// "event + budget atomicity" layer.
//
// What problem does this solve?
//
//   A naive concurrent dispatcher would read the current spend, decide
//   "remaining budget is $5, this subagent costs ~$2, dispatch it", and
//   write `task.started` — but TWO dispatches running this logic in parallel
//   could both observe $5 remaining, both pass the check, and over-spend.
//
//   The fix is to make (replay → check → append) atomic. Every reserve /
//   release / increase routes through the per-run `SerializedWriter`'s
//   `withExclusive` API, which holds an exclusive file lock for the full
//   critical section. Two concurrent callers serialize automatically.
//
// What this file is NOT:
//
//   * The dispatch loop — that's PR 4 (#191). This file exports the API
//     PR 4 calls to gate dispatch.
//   * A spend tracker for the v6 run-state engine's `phase.cost` events —
//     those remain unchanged. Reservations live alongside `phase.cost`
//     and exist solely to prevent concurrent over-commitment.
//
// Resume semantics:
//
//   Replay reconstructs current state by folding the event log:
//     reserved_total = sum(reserved + increased_reservation)
//     released_total = sum(released)
//     in_flight = reserved_total - released_total
//
//   `replayFromEvents` walks `events.ndjson` line-by-line and applies this
//   fold. A `task.budget_released` for a task without a matching
//   `task.budget_reserved` is a corruption signal and surfaces as a warning
//   (we trust the log as-written rather than throwing — the spec resume
//   classifier handles task-level state separately).
//
// Spec:
//   docs/superpowers/specs/2026-05-19-v7.11.0-concurrent-subagent-execution-design.md
//   sections "Budget reservation semantics" + "Integration with run-state
//   engine (v6)".

import * as fs from 'node:fs';

import { GuardrailError } from '../errors.ts';
import { SerializedWriter } from '../run-state/serialized-writer.ts';
import type { RunEvent } from '../run-state/types.ts';

/** Budget caps for a single run. `perRunUSD` is the hard ceiling across all
 *  concurrent tasks; `perSubagentUSD` is the per-task hard cap that
 *  dispatch refuses to exceed even if perRunUSD has headroom. */
export interface BudgetCaps {
  /** Total USD this run is allowed to spend across all subagents +
   *  reservations. */
  perRunUSD: number;
  /** Hard per-subagent cap. A pre-flight estimate exceeding this rejects
   *  dispatch; an actual cost exceeding it mid-execution triggers the
   *  scheduler's SIGTERM path (PR 4) — this layer just emits the
   *  `task.failed` event with `error_type: 'budget_exceeded'`. */
  perSubagentUSD: number;
}

/** Reservation entry kept in memory; reconstructed via `replayFromEvents`
 *  at startup / resume. */
export interface ReservationEntry {
  task_id: string;
  /** Latest reservation (after any `task.budget_increased_reservation`
   *  events). */
  reserved_usd: number;
  /** True once `task.budget_released` has landed for this task. */
  released: boolean;
  /** Actual cost if `released` is true. */
  actual_cost_usd?: number;
}

/** Result of replaying events.ndjson into a fresh ledger state. Useful for
 *  resume and for tests that want to assert reconstruction is exact. */
export interface BudgetReplaySummary {
  /** Sum of (reserved + increased_reservation) across all tasks, releases
   *  EXCLUDED. The dispatch headroom check is `caps.perRunUSD -
   *  in_flight_reserved`. */
  reservedTotal: number;
  /** Sum of `task.budget_released.actual_cost_usd` across all tasks. */
  releasedTotal: number;
  /** Per-task latest reservation. */
  perTask: Map<string, ReservationEntry>;
}

/** Thrown by `reserve()` / `increaseReservation()` when the requested
 *  amount would push the run over `perRunUSD`, or when a pre-flight
 *  exceeds `perSubagentUSD`. Carries the GuardrailError code
 *  `budget_exceeded` for upstream resume classification. */
export class BudgetExceededError extends GuardrailError {
  constructor(message: string, details: Record<string, unknown>) {
    super(message, {
      code: 'budget_exceeded',
      provider: 'concurrent-dispatch',
      details,
    });
  }
}

export interface ReserveOptions {
  /** Pre-flight cost estimate for the task in USD. */
  preFlightEstimateUsd: number;
  /** Budget caps for this run. */
  caps: BudgetCaps;
}

export interface IncreaseReservationOptions {
  /** New reservation total (NOT a delta — the absolute new value). */
  newReservedUsd: number;
  /** Free-form reason captured on the event. */
  reason: string;
  /** Budget caps for this run. */
  caps: BudgetCaps;
}

export interface ReleaseOptions {
  /** Actual cost spent by the subagent (from telemetry). */
  actualCostUsd: number;
}

/**
 * Budget reservation ledger. One instance per run, owned by the scheduler.
 * All mutations route through the supplied `SerializedWriter` so they are
 * atomic against concurrent callers and across the (replay → check →
 * append → fsync) critical section.
 */
export class BudgetReservation {
  /** In-memory mirror of disk state. Authoritative source is the event
   *  log; this cache exists to avoid re-replaying events.ndjson on every
   *  `reserve()` (we only need on-disk state to be consistent at the
   *  point we write a new event, and we recompute remaining-budget INSIDE
   *  the writer's exclusive lock from the cache). */
  private reservations = new Map<string, ReservationEntry>();
  private reservedTotal = 0;
  private releasedTotal = 0;

  constructor(private readonly writer: SerializedWriter) {}

  /** Re-seed in-memory state from events.ndjson. Call on construction OR
   *  on resume. Safe to call multiple times — it overwrites the cache. */
  async hydrateFromEvents(eventsNdjsonPath: string): Promise<void> {
    const summary = BudgetReservation.replayFromEvents(eventsNdjsonPath);
    this.reservations = summary.perTask;
    this.reservedTotal = summary.reservedTotal;
    this.releasedTotal = summary.releasedTotal;
  }

  /** Read the current in-memory state. Authoritative if `hydrateFromEvents`
   *  was called and no out-of-process writers exist (which is the single-
   *  scheduler-per-run contract). */
  snapshot(): BudgetReplaySummary {
    return {
      reservedTotal: this.reservedTotal,
      releasedTotal: this.releasedTotal,
      perTask: new Map(this.reservations),
    };
  }

  /**
   * Reserve budget for a task. Atomic under the writer lock:
   *
   *   1. Acquire SerializedWriter lock
   *   2. Verify `preFlightEstimate <= caps.perSubagentUSD` (HARD cap)
   *   3. Verify `caps.perRunUSD - in_flight_reserved >= preFlightEstimate`
   *   4. Append `task.budget_reserved` event + fsync
   *   5. Release lock
   *
   * Throws `BudgetExceededError` (without writing any event) if either
   * check fails — except for the "would exceed perRunUSD" path which emits
   * a `task.budget_halt` event UNDER the lock before throwing. The halt
   * event is the terminal record for the run's failure mode.
   */
  async reserve(taskId: string, opts: ReserveOptions): Promise<void> {
    // HARD per-subagent cap is checked BEFORE acquiring the lock — it's a
    // pure caller-side validation that doesn't need to read on-disk state.
    if (opts.preFlightEstimateUsd > opts.caps.perSubagentUSD) {
      throw new BudgetExceededError(
        `task.${taskId}: pre-flight estimate $${opts.preFlightEstimateUsd.toFixed(2)} exceeds perSubagentUSD cap of $${opts.caps.perSubagentUSD.toFixed(2)}`,
        {
          task_id: taskId,
          preFlightEstimateUsd: opts.preFlightEstimateUsd,
          perSubagentUSD: opts.caps.perSubagentUSD,
          violation: 'per_subagent_hard_cap',
        },
      );
    }
    if (opts.preFlightEstimateUsd < 0) {
      throw new GuardrailError(
        `task.${taskId}: pre-flight estimate must be >= 0 (got ${opts.preFlightEstimateUsd})`,
        {
          code: 'user_input',
          provider: 'concurrent-dispatch',
          details: { task_id: taskId, preFlightEstimateUsd: opts.preFlightEstimateUsd },
        },
      );
    }
    if (this.reservations.has(taskId) && !this.reservations.get(taskId)?.released) {
      throw new GuardrailError(
        `task.${taskId}: already has an in-flight reservation`,
        {
          code: 'adapter_bug',
          provider: 'concurrent-dispatch',
          details: { task_id: taskId },
        },
      );
    }

    await this.writer.withExclusive(async ({ writeEvent }) => {
      const inFlight = this.reservedTotal - this.releasedTotal;
      const remaining = opts.caps.perRunUSD - inFlight;
      if (remaining < opts.preFlightEstimateUsd) {
        // Halt: emit the terminal record THEN throw. The event lands first
        // so resume classifies this correctly even if the throw propagates
        // past a crash boundary.
        await writeEvent({
          event: 'task.budget_halt',
          task_id: taskId,
          budget_remaining_usd: remaining,
          preflight_estimate_usd: opts.preFlightEstimateUsd,
        });
        throw new BudgetExceededError(
          `task.${taskId}: remaining budget $${remaining.toFixed(2)} below pre-flight estimate $${opts.preFlightEstimateUsd.toFixed(2)} (perRunUSD=$${opts.caps.perRunUSD.toFixed(2)}, in_flight=$${inFlight.toFixed(2)})`,
          {
            task_id: taskId,
            preFlightEstimateUsd: opts.preFlightEstimateUsd,
            perRunUSD: opts.caps.perRunUSD,
            inFlightReservedUsd: inFlight,
            remaining,
            violation: 'per_run_cap_at_reserve',
          },
        );
      }

      // Reservation approved. Append event + update cache.
      await writeEvent({
        event: 'task.budget_reserved',
        task_id: taskId,
        reserved_usd: opts.preFlightEstimateUsd,
        run_budget_remaining_after_reservation_usd:
          remaining - opts.preFlightEstimateUsd,
      });
      this.reservations.set(taskId, {
        task_id: taskId,
        reserved_usd: opts.preFlightEstimateUsd,
        released: false,
      });
      this.reservedTotal += opts.preFlightEstimateUsd;
    });
  }

  /**
   * Bump an in-flight reservation. Atomic under the writer lock.
   * Re-checks `perRunUSD` against the NEW reservation total; halts the
   * run with `task.budget_halt` if the bump would exceed the cap.
   *
   * Throws `BudgetExceededError` if no prior reservation exists, the bump
   * is downward (use `release` instead), or the bump exceeds caps.
   */
  async increaseReservation(
    taskId: string,
    opts: IncreaseReservationOptions,
  ): Promise<void> {
    const prior = this.reservations.get(taskId);
    if (!prior || prior.released) {
      throw new GuardrailError(
        `task.${taskId}: cannot increase reservation; no in-flight reservation found`,
        {
          code: 'adapter_bug',
          provider: 'concurrent-dispatch',
          details: { task_id: taskId },
        },
      );
    }
    if (opts.newReservedUsd <= prior.reserved_usd) {
      throw new GuardrailError(
        `task.${taskId}: increaseReservation must raise the cap (prior=$${prior.reserved_usd.toFixed(2)}, new=$${opts.newReservedUsd.toFixed(2)})`,
        {
          code: 'user_input',
          provider: 'concurrent-dispatch',
          details: {
            task_id: taskId,
            priorReservedUsd: prior.reserved_usd,
            newReservedUsd: opts.newReservedUsd,
          },
        },
      );
    }
    if (opts.newReservedUsd > opts.caps.perSubagentUSD) {
      throw new BudgetExceededError(
        `task.${taskId}: increased reservation $${opts.newReservedUsd.toFixed(2)} exceeds perSubagentUSD cap of $${opts.caps.perSubagentUSD.toFixed(2)}`,
        {
          task_id: taskId,
          newReservedUsd: opts.newReservedUsd,
          perSubagentUSD: opts.caps.perSubagentUSD,
          violation: 'per_subagent_hard_cap_on_increase',
        },
      );
    }

    const delta = opts.newReservedUsd - prior.reserved_usd;

    await this.writer.withExclusive(async ({ writeEvent }) => {
      const inFlight = this.reservedTotal - this.releasedTotal;
      const remainingAfterBump = opts.caps.perRunUSD - (inFlight + delta);
      if (remainingAfterBump < 0) {
        await writeEvent({
          event: 'task.budget_halt',
          task_id: taskId,
          budget_remaining_usd: opts.caps.perRunUSD - inFlight,
          preflight_estimate_usd: delta,
        });
        throw new BudgetExceededError(
          `task.${taskId}: increase reservation by $${delta.toFixed(2)} would exceed perRunUSD cap of $${opts.caps.perRunUSD.toFixed(2)} (in_flight=$${inFlight.toFixed(2)})`,
          {
            task_id: taskId,
            priorReservedUsd: prior.reserved_usd,
            newReservedUsd: opts.newReservedUsd,
            delta,
            perRunUSD: opts.caps.perRunUSD,
            inFlightReservedUsd: inFlight,
            violation: 'per_run_cap_at_increase',
          },
        );
      }

      // Bump approved. Append event + update cache.
      await writeEvent({
        event: 'task.budget_increased_reservation',
        task_id: taskId,
        prior_reserved_usd: prior.reserved_usd,
        new_reserved_usd: opts.newReservedUsd,
        reason: opts.reason,
      });
      prior.reserved_usd = opts.newReservedUsd;
      this.reservedTotal += delta;
    });
  }

  /**
   * Release a reservation with the actual cost. Atomic under the writer
   * lock. Emits `task.budget_released` with the delta-vs-reservation
   * (positive = under, negative = over).
   *
   * Releasing a non-existent reservation is a no-op event-wise (no log
   * pollution) but throws `adapter_bug` for caller-side visibility — the
   * scheduler should always reserve before releasing.
   */
  async release(taskId: string, opts: ReleaseOptions): Promise<void> {
    const prior = this.reservations.get(taskId);
    if (!prior) {
      throw new GuardrailError(
        `task.${taskId}: cannot release; no reservation found`,
        {
          code: 'adapter_bug',
          provider: 'concurrent-dispatch',
          details: { task_id: taskId },
        },
      );
    }
    if (prior.released) {
      throw new GuardrailError(
        `task.${taskId}: reservation already released`,
        {
          code: 'adapter_bug',
          provider: 'concurrent-dispatch',
          details: { task_id: taskId },
        },
      );
    }
    if (opts.actualCostUsd < 0) {
      throw new GuardrailError(
        `task.${taskId}: actual cost must be >= 0 (got ${opts.actualCostUsd})`,
        {
          code: 'user_input',
          provider: 'concurrent-dispatch',
          details: { task_id: taskId, actualCostUsd: opts.actualCostUsd },
        },
      );
    }

    const delta = prior.reserved_usd - opts.actualCostUsd;

    await this.writer.withExclusive(async ({ writeEvent }) => {
      await writeEvent({
        event: 'task.budget_released',
        task_id: taskId,
        actual_cost_usd: opts.actualCostUsd,
        delta_vs_reservation_usd: delta,
      });
      prior.released = true;
      prior.actual_cost_usd = opts.actualCostUsd;
      this.releasedTotal += opts.actualCostUsd;
    });
  }

  // -------------------------------------------------------------------------
  // Replay — pure, no IO beyond reading the events file. Static so resume
  // and tests can call it without instantiating a writer.
  // -------------------------------------------------------------------------

  /**
   * Replay events.ndjson into a fresh `BudgetReplaySummary`. Used by:
   *   1. `hydrateFromEvents` — runtime cache seed on resume / startup
   *   2. tests — to assert reconstruction is exact
   *
   * Line parsing is lenient: blank lines are skipped, parse failures are
   * treated as truncated-tail signals and stop the walk (the next
   * `appendEvent` would emit `run.recovery`; budget state stays
   * consistent up to the last-known-good line).
   *
   * Returns the summary even on a missing file (empty summary).
   */
  static replayFromEvents(eventsNdjsonPath: string): BudgetReplaySummary {
    const perTask = new Map<string, ReservationEntry>();
    let reservedTotal = 0;
    let releasedTotal = 0;

    if (!fs.existsSync(eventsNdjsonPath)) {
      return { reservedTotal, releasedTotal, perTask };
    }
    const raw = fs.readFileSync(eventsNdjsonPath, 'utf8');
    if (!raw) return { reservedTotal, releasedTotal, perTask };

    const lines = raw.split('\n');
    const endsWithNewline = raw.endsWith('\n');
    const lastIdx = endsWithNewline ? lines.length - 2 : lines.length - 2;
    // `split('\n')` on a file ending in '\n' produces a trailing ''. We use
    // `lastIdx = lines.length - 2` to skip it. On a truncated tail (no
    // trailing '\n'), the LAST line is also dropped because we can't trust
    // it to be a complete JSON object.

    for (let i = 0; i <= lastIdx; i++) {
      const line = lines[i];
      if (!line) continue;
      let ev: RunEvent;
      try {
        ev = JSON.parse(line) as RunEvent;
      } catch {
        // Mid-file corruption — stop the walk. The on-disk log is the
        // source of truth; this fold is best-effort. The next appendEvent
        // will emit a recovery marker.
        break;
      }
      if (!ev || typeof ev !== 'object' || typeof ev.event !== 'string') continue;

      switch (ev.event) {
        case 'task.budget_reserved': {
          const entry: ReservationEntry = {
            task_id: ev.task_id,
            reserved_usd: ev.reserved_usd,
            released: false,
          };
          perTask.set(ev.task_id, entry);
          reservedTotal += ev.reserved_usd;
          break;
        }
        case 'task.budget_increased_reservation': {
          const entry = perTask.get(ev.task_id);
          if (!entry) {
            // Log gap — the reserved event is missing. Treat the bump as
            // the new baseline so the in-memory state at least reflects
            // disk. Resume will surface the inconsistency elsewhere.
            perTask.set(ev.task_id, {
              task_id: ev.task_id,
              reserved_usd: ev.new_reserved_usd,
              released: false,
            });
            reservedTotal += ev.new_reserved_usd;
            break;
          }
          const delta = ev.new_reserved_usd - entry.reserved_usd;
          entry.reserved_usd = ev.new_reserved_usd;
          reservedTotal += delta;
          break;
        }
        case 'task.budget_released': {
          const entry = perTask.get(ev.task_id);
          if (!entry) {
            // Released without reservation — surface as a phantom entry
            // so resume can detect it. We don't increment releasedTotal
            // because there was no offsetting reservation.
            perTask.set(ev.task_id, {
              task_id: ev.task_id,
              reserved_usd: 0,
              released: true,
              actual_cost_usd: ev.actual_cost_usd,
            });
            break;
          }
          entry.released = true;
          entry.actual_cost_usd = ev.actual_cost_usd;
          releasedTotal += ev.actual_cost_usd;
          break;
        }
        default:
          // Other event types don't affect budget ledger state.
          break;
      }
    }

    return { reservedTotal, releasedTotal, perTask };
  }
}
