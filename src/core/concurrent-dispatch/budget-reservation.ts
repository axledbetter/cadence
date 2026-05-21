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
//   critical section. Under that lock we re-replay events.ndjson from disk
//   (authoritative source) BEFORE the budget check, so even a second
//   `BudgetReservation` instance (or a second scheduler process) sees the
//   first instance's appended reservation before its own check runs.
//
// Budget accounting model (corrected after Codex pass 1):
//
//   We track three running totals (internally as INTEGER MICROS to avoid
//   floating-point drift; see "Why integer micros" below):
//
//     spentTotal       = sum of `task.budget_released.actual_cost_usd`
//                        — money the subagent actually spent and we now
//                        commit against the run cap.
//
//     activeReservedTotal = sum of (reserved_usd) for tasks whose latest
//                           event is `task.budget_reserved` or
//                           `task.budget_increased_reservation` (NOT yet
//                           released). The latest increase REPLACES the
//                           prior reserved value (absolute, not delta).
//
//     committedTotal   = spentTotal + activeReservedTotal
//
//   The headroom check is `caps.perRunUSD - committedTotal >= newReservation`.
//   Releasing a task: spentTotal += actualCost; activeReservedTotal -=
//   reserved. Net effect: a $6 reservation released with $6 actual spend
//   moves $6 from "active reserved" to "spent" — total commitment is
//   unchanged. Earlier the naive `in_flight = reserved - released_actual`
//   model would have left $0 committed, allowing the run to over-spend.
//
// Why replay events.ndjson on every reserve?
//
//   The single-scheduler-per-run contract is enforced upstream (by the
//   per-run lock in `lock.ts` + cross-process repo lock from PR 2), so in
//   well-behaved deployments the in-memory cache and disk state agree.
//
//   But the file lock alone doesn't prevent stale-cache reasoning if a
//   second `BudgetReservation` instance is created (e.g. test bug, a
//   resumed run that didn't `hydrateFromEvents`, or a future BullMQ
//   worker design). Authoritative replay inside the lock is the
//   correctness floor; the cache is just an optimisation.
//
//   Cost: O(n) read of events.ndjson per reserve, where n = number of
//   events so far. Acceptable up to ~100k events per run; if we ever push
//   beyond that we can add a `budget-state-cache.json` checkpoint.
//
// Why integer micros (Codex pass 1, WARN #6)?
//
//   JS `number` is IEEE-754 double, so naive USD arithmetic accumulates
//   error: `0.1 + 0.2 === 0.30000000000000004`. Over thousands of
//   reservations this drift can flip a cap check the wrong way. We store
//   all internal totals as integer micros (1 USD = 1_000_000 micros).
//   Range: `Number.MAX_SAFE_INTEGER / 1_000_000 ≈ $9.007e9` — way more
//   than any plausible per-run budget. Public API still accepts and emits
//   decimal USD; we convert at the boundary via `Math.round(usd *
//   1_000_000)` (input) and `micros / 1_000_000` (output).
//
// What this file is NOT:
//
//   * The dispatch loop — that's PR 4 (#191). This file exports the API
//     PR 4 calls to gate dispatch.
//   * A spend tracker for the v6 run-state engine's `phase.cost` events —
//     those remain unchanged. Reservations live alongside `phase.cost`.
//
// Spec:
//   docs/superpowers/specs/2026-05-19-v7.11.0-concurrent-subagent-execution-design.md
//   sections "Budget reservation semantics" + "Integration with run-state
//   engine (v6)".

import * as fs from 'node:fs';

import { GuardrailError } from '../errors.ts';
import { SerializedWriter } from '../run-state/serialized-writer.ts';
import type { RunEvent } from '../run-state/types.ts';

// ---- Micros conversion helpers -------------------------------------------
// 1 USD = 1_000_000 micros. Round half-to-even at the boundary so $0.1 +
// $0.2 → 100000 + 200000 = 300000 micros = $0.30 (NOT $0.30000000000000004).
const MICROS_PER_USD = 1_000_000;
function usdToMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD);
}
function microsToUsd(micros: number): number {
  return micros / MICROS_PER_USD;
}

/** Budget caps for a single run. `perRunUSD` is the hard ceiling on total
 *  committed spend (spent + active reservations) across all concurrent
 *  tasks. `perSubagentUSD` is the per-task hard cap that dispatch refuses
 *  to exceed even if perRunUSD has headroom. */
export interface BudgetCaps {
  /** Total USD this run is allowed to commit across all subagents +
   *  in-flight reservations. */
  perRunUSD: number;
  /** Hard per-subagent cap. A pre-flight estimate exceeding this rejects
   *  dispatch; an actual cost exceeding it mid-execution triggers the
   *  scheduler's SIGTERM path (PR 4) — this layer just emits the
   *  `task.failed` event with `error_type: 'budget_exceeded'`. */
  perSubagentUSD: number;
}

/** Per-task ledger entry. Reconstructed via `replayFromEvents` at startup
 *  / resume. */
export interface ReservationEntry {
  task_id: string;
  /** Latest reservation value (after any
   *  `task.budget_increased_reservation` events; ABSOLUTE, not delta). */
  reserved_usd: number;
  /** True once `task.budget_released` has landed for this task. */
  released: boolean;
  /** Actual cost if `released` is true. */
  actual_cost_usd?: number;
}

/** Result of replaying events.ndjson into a fresh ledger state. */
export interface BudgetReplaySummary {
  /** Sum of `actual_cost_usd` across released tasks. Committed against
   *  `perRunUSD` permanently. */
  spentTotal: number;
  /** Sum of `reserved_usd` for tasks NOT yet released. Each task
   *  contributes its LATEST reservation (absolute value), not the sum of
   *  reserved + increased values. */
  activeReservedTotal: number;
  /** `spentTotal + activeReservedTotal`. The number the headroom check
   *  compares against `perRunUSD`. */
  committedTotal: number;
  /** Per-task latest state. */
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
 * All mutations route through the supplied `SerializedWriter` and re-replay
 * events.ndjson under the exclusive lock so they are atomic against
 * concurrent callers AND any other `BudgetReservation` instances pointed at
 * the same run.
 */
export class BudgetReservation {
  /** In-memory mirror of disk state, kept for fast `snapshot()` reads.
   *  NOT authoritative — every mutating operation re-replays the on-disk
   *  log inside the writer's exclusive lock before checking caps. Per-task
   *  reservations stored in USD (public API); the running totals below are
   *  in MICROS (integer-safe arithmetic). */
  private reservations = new Map<string, ReservationEntry>();
  private spentMicros = 0;
  private activeReservedMicros = 0;

  constructor(private readonly writer: SerializedWriter) {}

  /** Re-seed in-memory state from events.ndjson. Call on construction OR
   *  on resume. Safe to call multiple times — overwrites the cache. */
  async hydrateFromEvents(eventsNdjsonPath: string): Promise<void> {
    const replay = BudgetReservation.replayFromEventsMicros(eventsNdjsonPath);
    this.applyReplayMicros(replay);
  }

  /** Read the current in-memory state. Best-effort: a concurrent writer
   *  in another instance could make this stale until the next mutating
   *  call re-hydrates from disk. */
  snapshot(): BudgetReplaySummary {
    return {
      spentTotal: microsToUsd(this.spentMicros),
      activeReservedTotal: microsToUsd(this.activeReservedMicros),
      committedTotal: microsToUsd(this.spentMicros + this.activeReservedMicros),
      perTask: new Map(this.reservations),
    };
  }

  /**
   * Reserve budget for a task. Atomic under the writer lock:
   *
   *   1. HARD cap check (pre-lock): `preFlightEstimate <= caps.perSubagentUSD`
   *   2. Acquire SerializedWriter lock
   *   3. Re-replay events.ndjson from disk (authoritative)
   *   4. Verify task doesn't already have an in-flight reservation
   *   5. Verify `caps.perRunUSD - committedTotal >= preFlightEstimate`
   *      (committedTotal = spent + active reservations)
   *   6. If pass: append `task.budget_reserved` event + fsync
   *      If fail: append `task.budget_halt` event + fsync, then throw
   *   7. Release lock
   *
   * Throws `BudgetExceededError` on cap violations. The `task.budget_halt`
   * variant is durable: the event lands inside the same critical section
   * before the throw propagates, so a crash post-throw still surfaces the
   * halt on resume.
   */
  async reserve(taskId: string, opts: ReserveOptions): Promise<void> {
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

    const preflightMicros = usdToMicros(opts.preFlightEstimateUsd);
    const perRunMicros = usdToMicros(opts.caps.perRunUSD);

    await this.writer.withExclusive(async ({ writeEvent, eventsNdjsonPath }) => {
      // Authoritative replay INSIDE the lock — defends against stale
      // cache when multiple BudgetReservation instances share an event
      // file. Also rebuilds our own cache so the next snapshot() call
      // reflects disk state.
      const disk = BudgetReservation.replayFromEventsMicros(eventsNdjsonPath);
      this.applyReplayMicros(disk);

      const existing = this.reservations.get(taskId);
      if (existing && !existing.released) {
        throw new GuardrailError(
          `task.${taskId}: already has an in-flight reservation`,
          {
            code: 'adapter_bug',
            provider: 'concurrent-dispatch',
            details: { task_id: taskId },
          },
        );
      }

      const committedMicros = this.spentMicros + this.activeReservedMicros;
      const remainingMicros = perRunMicros - committedMicros;
      if (remainingMicros < preflightMicros) {
        // Halt: emit the terminal record THEN throw. The event lands
        // first so resume classifies this correctly even if the throw
        // propagates past a crash boundary.
        const remainingUsd = microsToUsd(remainingMicros);
        await writeEvent({
          event: 'task.budget_halt',
          task_id: taskId,
          budget_remaining_usd: remainingUsd,
          preflight_estimate_usd: opts.preFlightEstimateUsd,
        });
        throw new BudgetExceededError(
          `task.${taskId}: remaining budget $${remainingUsd.toFixed(2)} below pre-flight estimate $${opts.preFlightEstimateUsd.toFixed(2)} (perRunUSD=$${opts.caps.perRunUSD.toFixed(2)}, spent=$${microsToUsd(this.spentMicros).toFixed(2)}, active=$${microsToUsd(this.activeReservedMicros).toFixed(2)})`,
          {
            task_id: taskId,
            preFlightEstimateUsd: opts.preFlightEstimateUsd,
            perRunUSD: opts.caps.perRunUSD,
            spentTotalUsd: microsToUsd(this.spentMicros),
            activeReservedTotalUsd: microsToUsd(this.activeReservedMicros),
            remaining: remainingUsd,
            violation: 'per_run_cap_at_reserve',
          },
        );
      }

      // Reservation approved. Append event + update cache.
      const remainingAfterMicros = remainingMicros - preflightMicros;
      await writeEvent({
        event: 'task.budget_reserved',
        task_id: taskId,
        reserved_usd: opts.preFlightEstimateUsd,
        run_budget_remaining_after_reservation_usd: microsToUsd(remainingAfterMicros),
      });
      this.reservations.set(taskId, {
        task_id: taskId,
        reserved_usd: opts.preFlightEstimateUsd,
        released: false,
      });
      this.activeReservedMicros += preflightMicros;
    });
  }

  /**
   * Bump an in-flight reservation to a new ABSOLUTE value. Atomic under
   * the writer lock; re-replays disk state before checking caps.
   * Re-checks `perRunUSD` against the NEW reservation total; halts the
   * run with `task.budget_halt` if the bump would exceed the cap.
   *
   * Throws `BudgetExceededError` (with durable `task.budget_halt`) if no
   * prior reservation exists, the bump is downward (use `release`
   * instead), or the bump exceeds caps.
   */
  async increaseReservation(
    taskId: string,
    opts: IncreaseReservationOptions,
  ): Promise<void> {
    // Pre-lock validation that doesn't depend on on-disk state.
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

    const newReservedMicros = usdToMicros(opts.newReservedUsd);
    const perRunMicros = usdToMicros(opts.caps.perRunUSD);

    await this.writer.withExclusive(async ({ writeEvent, eventsNdjsonPath }) => {
      const disk = BudgetReservation.replayFromEventsMicros(eventsNdjsonPath);
      this.applyReplayMicros(disk);

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
      const priorReservedMicros = usdToMicros(prior.reserved_usd);
      if (newReservedMicros <= priorReservedMicros) {
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

      const deltaMicros = newReservedMicros - priorReservedMicros;
      const projectedCommittedMicros =
        this.spentMicros + this.activeReservedMicros + deltaMicros;
      if (projectedCommittedMicros > perRunMicros) {
        const remainingMicros =
          perRunMicros - (this.spentMicros + this.activeReservedMicros);
        await writeEvent({
          event: 'task.budget_halt',
          task_id: taskId,
          budget_remaining_usd: microsToUsd(remainingMicros),
          preflight_estimate_usd: microsToUsd(deltaMicros),
        });
        throw new BudgetExceededError(
          `task.${taskId}: increase reservation by $${microsToUsd(deltaMicros).toFixed(2)} would commit $${microsToUsd(projectedCommittedMicros).toFixed(2)} vs perRunUSD cap of $${opts.caps.perRunUSD.toFixed(2)} (spent=$${microsToUsd(this.spentMicros).toFixed(2)}, active=$${microsToUsd(this.activeReservedMicros).toFixed(2)})`,
          {
            task_id: taskId,
            priorReservedUsd: prior.reserved_usd,
            newReservedUsd: opts.newReservedUsd,
            delta: microsToUsd(deltaMicros),
            perRunUSD: opts.caps.perRunUSD,
            spentTotalUsd: microsToUsd(this.spentMicros),
            activeReservedTotalUsd: microsToUsd(this.activeReservedMicros),
            projectedCommittedUsd: microsToUsd(projectedCommittedMicros),
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
      this.activeReservedMicros += deltaMicros;
    });
  }

  /**
   * Release a reservation with the actual cost. Atomic under the writer
   * lock; re-replays disk state. Moves the task's commitment from
   * `activeReserved` to `spent`. Emits `task.budget_released` with
   * `delta_vs_reservation_usd` (positive = under, negative = over).
   *
   * Note: a release with `actualCostUsd > reserved_usd` is NOT a halt —
   * the budget was already committed at reservation time. The scheduler
   * is expected to issue `increaseReservation` mid-flight when telemetry
   * suggests overrun, and to emit `task.failed{error_type:'budget_exceeded'}`
   * if the increase itself fails. This `release` just records the truth.
   */
  async release(taskId: string, opts: ReleaseOptions): Promise<void> {
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

    const actualMicros = usdToMicros(opts.actualCostUsd);

    await this.writer.withExclusive(async ({ writeEvent, eventsNdjsonPath }) => {
      const disk = BudgetReservation.replayFromEventsMicros(eventsNdjsonPath);
      this.applyReplayMicros(disk);

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

      const priorReservedMicros = usdToMicros(prior.reserved_usd);
      const deltaMicros = priorReservedMicros - actualMicros;

      await writeEvent({
        event: 'task.budget_released',
        task_id: taskId,
        actual_cost_usd: opts.actualCostUsd,
        delta_vs_reservation_usd: microsToUsd(deltaMicros),
      });
      prior.released = true;
      prior.actual_cost_usd = opts.actualCostUsd;
      // Move commitment from "active reserved" to "spent". Net effect on
      // committedTotal: prior.reserved_usd was reserved, now actualCost
      // is spent — committedTotal changes by (actualCost - reserved_usd).
      // If actualCost < reserved: committed goes DOWN (we free unused
      // reservation). If actualCost == reserved: no change. If actualCost
      // > reserved: committed goes UP (the overspend is recorded).
      this.activeReservedMicros -= priorReservedMicros;
      this.spentMicros += actualMicros;
    });
  }

  /** Internal: replace in-memory ledger from a replay summary (in micros).
   *  Used by every mutating method to re-sync cache with disk under the
   *  lock. */
  private applyReplayMicros(replay: ReplaySummaryMicros): void {
    this.reservations = replay.perTask;
    this.spentMicros = replay.spentMicros;
    this.activeReservedMicros = replay.activeReservedMicros;
  }

  // -------------------------------------------------------------------------
  // Replay — pure, no IO beyond reading the events file. Static so resume
  // and tests can call it without instantiating a writer.
  // -------------------------------------------------------------------------

  /**
   * Replay events.ndjson into a fresh `BudgetReplaySummary` (decimal USD).
   * Used by:
   *   1. `hydrateFromEvents` — runtime cache seed on resume / startup
   *   2. tests — to assert reconstruction is exact
   *
   * Internally calls `replayFromEventsMicros` and converts to USD at the
   * boundary so external consumers see decimal numbers, but the fold itself
   * is integer-micro arithmetic.
   *
   * Line parsing is lenient: blank lines are skipped, parse failures stop
   * the walk (treated as truncated tail; the next `appendEvent` would
   * emit `run.recovery`, and budget state stays consistent up to the
   * last-known-good line).
   */
  static replayFromEvents(eventsNdjsonPath: string): BudgetReplaySummary {
    const micros = BudgetReservation.replayFromEventsMicros(eventsNdjsonPath);
    return {
      spentTotal: microsToUsd(micros.spentMicros),
      activeReservedTotal: microsToUsd(micros.activeReservedMicros),
      committedTotal: microsToUsd(micros.spentMicros + micros.activeReservedMicros),
      perTask: micros.perTask,
    };
  }

  /**
   * Internal: micro-precision replay. Used by every mutating method INSIDE
   * `withExclusive` so cap checks operate on integer arithmetic.
   */
  private static replayFromEventsMicros(eventsNdjsonPath: string): ReplaySummaryMicros {
    const perTask = new Map<string, ReservationEntry>();
    let spentMicros = 0;
    let activeReservedMicros = 0;

    if (!fs.existsSync(eventsNdjsonPath)) {
      return { spentMicros, activeReservedMicros, perTask };
    }
    const raw = fs.readFileSync(eventsNdjsonPath, 'utf8');
    if (!raw) {
      return { spentMicros, activeReservedMicros, perTask };
    }

    const endsWithNewline = raw.endsWith('\n');
    const lines = raw.split('\n');
    // `split('\n')` on a file ending in '\n' produces a trailing ''. We
    // drop it. On a truncated tail (no trailing '\n'), the LAST line is
    // also dropped because we can't trust it to be a complete JSON
    // object.
    const lastIdx = endsWithNewline ? lines.length - 2 : lines.length - 2;

    for (let i = 0; i <= lastIdx; i++) {
      const line = lines[i];
      if (!line) continue;
      let ev: RunEvent;
      try {
        ev = JSON.parse(line) as RunEvent;
      } catch {
        // Mid-file corruption — stop the walk. The events file is the
        // source of truth; this fold is best-effort and conservative
        // (we keep state up to the last valid line).
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
          activeReservedMicros += usdToMicros(ev.reserved_usd);
          break;
        }
        case 'task.budget_increased_reservation': {
          const entry = perTask.get(ev.task_id);
          if (!entry) {
            // Log gap — the reserved event is missing. Treat the
            // increase's new value as the baseline so cache reflects
            // disk; resume will surface this elsewhere.
            perTask.set(ev.task_id, {
              task_id: ev.task_id,
              reserved_usd: ev.new_reserved_usd,
              released: false,
            });
            activeReservedMicros += usdToMicros(ev.new_reserved_usd);
            break;
          }
          // `new_reserved_usd` is the ABSOLUTE new reservation, so we
          // adjust the running total by the delta from prior, not by
          // adding the new value. (Codex pass 1 flagged the prior
          // comment as ambiguous; the implementation here is the
          // intended semantics.)
          const priorMicros = usdToMicros(entry.reserved_usd);
          const newMicros = usdToMicros(ev.new_reserved_usd);
          entry.reserved_usd = ev.new_reserved_usd;
          activeReservedMicros += newMicros - priorMicros;
          break;
        }
        case 'task.budget_released': {
          const entry = perTask.get(ev.task_id);
          if (!entry) {
            // Released without reservation — record the phantom entry
            // so resume can detect it. We DO count the actual cost
            // against `spentMicros` because the money was spent; the
            // missing reservation is a separate corruption signal.
            perTask.set(ev.task_id, {
              task_id: ev.task_id,
              reserved_usd: 0,
              released: true,
              actual_cost_usd: ev.actual_cost_usd,
            });
            spentMicros += usdToMicros(ev.actual_cost_usd);
            break;
          }
          entry.released = true;
          entry.actual_cost_usd = ev.actual_cost_usd;
          // Move commitment from "active reserved" to "spent".
          activeReservedMicros -= usdToMicros(entry.reserved_usd);
          spentMicros += usdToMicros(ev.actual_cost_usd);
          break;
        }
        default:
          // Other event types don't affect budget ledger state.
          break;
      }
    }

    return { spentMicros, activeReservedMicros, perTask };
  }
}

/** Internal replay shape that preserves micro precision across the fold. */
interface ReplaySummaryMicros {
  spentMicros: number;
  activeReservedMicros: number;
  perTask: Map<string, ReservationEntry>;
}
