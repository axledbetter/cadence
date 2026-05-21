// tests/concurrent-dispatch/budget-reservation.test.ts
//
// Tests for the budget reservation ledger (PR 3/6, v7.11.0). Covers issue
// #190 acceptance bullets PLUS Codex pass-1 findings:
//
//   CRITICAL 1: replay events.ndjson under the writer lock — proved via
//     two-instance test (each instance holds its own SerializedWriter
//     pointed at the same events.ndjson; second observes first's
//     reservation before its check).
//   CRITICAL 2: corrected accounting model — committedTotal = spentTotal
//     + activeReservedTotal. Releases preserve commitment, not free it.
//   WARN 3: absolute (not delta) semantics for `increaseReservation`.
//   WARN 4: `task.budget_halt` lands atomically under the same lock
//     BEFORE `BudgetExceededError` is thrown.
//   WARN 5: cross-instance reservation visibility.
//   WARN 6: integer-micro internal arithmetic survives float boundary
//     cases like `$0.1 + $0.2`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  BudgetReservation,
  BudgetExceededError,
  type BudgetCaps,
} from '../../src/core/concurrent-dispatch/budget-reservation.ts';
import { SerializedWriter } from '../../src/core/run-state/serialized-writer.ts';
import type { RunEvent, WriterId } from '../../src/core/run-state/types.ts';

const testWriterId: WriterId = { pid: process.pid, hostHash: 'test-host' };

function tmpRun(): { runDir: string; eventsPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-reservation-'));
  return { runDir: dir, eventsPath: path.join(dir, 'events.ndjson') };
}

async function newSetup(): Promise<{
  eventsPath: string;
  writer: SerializedWriter;
  ledger: BudgetReservation;
  cleanup: () => Promise<void>;
}> {
  const { eventsPath } = tmpRun();
  const writer = await SerializedWriter.create({
    eventsNdjsonPath: eventsPath,
    writerId: testWriterId,
    pollIntervalMs: 1,
    maxBlockingAttempts: 1000,
  });
  const ledger = new BudgetReservation(writer);
  return {
    eventsPath,
    writer,
    ledger,
    cleanup: async () => {
      await writer.close();
    },
  };
}

const DEFAULT_CAPS: BudgetCaps = { perRunUSD: 10, perSubagentUSD: 3 };

function readEventLines(eventsPath: string): RunEvent[] {
  const raw = fs.readFileSync(eventsPath, 'utf8');
  if (!raw) return [];
  return raw
    .trim()
    .split('\n')
    .filter(l => l.length > 0)
    .map(l => JSON.parse(l) as RunEvent);
}

describe('BudgetReservation.reserve', () => {
  it('writes task.budget_reserved on success and updates snapshot', async () => {
    const { eventsPath, ledger, cleanup } = await newSetup();
    try {
      await ledger.reserve('t1', { preFlightEstimateUsd: 1.5, caps: DEFAULT_CAPS });
      const snap = ledger.snapshot();
      assert.equal(snap.activeReservedTotal, 1.5);
      assert.equal(snap.spentTotal, 0);
      assert.equal(snap.committedTotal, 1.5);
      assert.equal(snap.perTask.get('t1')?.reserved_usd, 1.5);

      const events = readEventLines(eventsPath);
      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.event, 'task.budget_reserved');
      assert.equal(
        (ev as Extract<RunEvent, { event: 'task.budget_reserved' }>).reserved_usd,
        1.5,
      );
    } finally {
      await cleanup();
    }
  });

  it('rejects when preFlightEstimate > perSubagentUSD (HARD cap, no event)', async () => {
    const { eventsPath, ledger, cleanup } = await newSetup();
    try {
      await assert.rejects(
        ledger.reserve('t1', {
          preFlightEstimateUsd: 5,
          caps: { perRunUSD: 100, perSubagentUSD: 3 },
        }),
        (err: Error) => {
          assert.ok(err instanceof BudgetExceededError);
          return true;
        },
      );
      // No event written — the hard cap check is pre-lock and never
      // acquires the writer.
      const events = readEventLines(eventsPath);
      assert.equal(events.length, 0);
      // Snapshot unchanged.
      assert.equal(ledger.snapshot().committedTotal, 0);
    } finally {
      await cleanup();
    }
  });

  it('emits task.budget_halt when perRunUSD would be exceeded', async () => {
    const { eventsPath, ledger, cleanup } = await newSetup();
    try {
      // Use the full budget on t1/t2/t3.
      await ledger.reserve('t1', { preFlightEstimateUsd: 3, caps: DEFAULT_CAPS });
      await ledger.reserve('t2', { preFlightEstimateUsd: 3, caps: DEFAULT_CAPS });
      await ledger.reserve('t3', { preFlightEstimateUsd: 3, caps: DEFAULT_CAPS });
      // Now only $1 remains. A $2 reservation should halt.
      await assert.rejects(
        ledger.reserve('t4', { preFlightEstimateUsd: 2, caps: DEFAULT_CAPS }),
        (err: Error) => err instanceof BudgetExceededError,
      );
      const events = readEventLines(eventsPath);
      // 3 budget_reserved + 1 budget_halt
      assert.equal(events.length, 4);
      assert.equal(events[3]!.event, 'task.budget_halt');
      assert.equal(
        (events[3]! as Extract<RunEvent, { event: 'task.budget_halt' }>).task_id,
        't4',
      );
    } finally {
      await cleanup();
    }
  });

  it('budget_halt event is durably committed BEFORE the throw (WARN #4)', async () => {
    // Codex pass 1 WARN #4: halt event must land under the same lock as
    // the rejected reserve, atomically. Prove by inspecting the file
    // immediately after the throw — it should already contain the halt
    // line even though the caller saw a rejection.
    const { eventsPath, ledger, cleanup } = await newSetup();
    try {
      const caps: BudgetCaps = { perRunUSD: 1, perSubagentUSD: 1 };
      await ledger.reserve('t1', { preFlightEstimateUsd: 1, caps });
      let threw = false;
      try {
        await ledger.reserve('t2', { preFlightEstimateUsd: 1, caps });
      } catch (err) {
        threw = true;
        assert.ok(err instanceof BudgetExceededError);
        // Read disk INSIDE the catch — the halt must already be there.
        const events = readEventLines(eventsPath);
        assert.equal(events.length, 2);
        assert.equal(events[1]!.event, 'task.budget_halt');
        assert.equal(
          (events[1]! as Extract<RunEvent, { event: 'task.budget_halt' }>).task_id,
          't2',
        );
      }
      assert.equal(threw, true, 'expected reserve to reject');
    } finally {
      await cleanup();
    }
  });

  it('rejects double-reserve of the same task', async () => {
    const { ledger, cleanup } = await newSetup();
    try {
      await ledger.reserve('t1', { preFlightEstimateUsd: 1, caps: DEFAULT_CAPS });
      await assert.rejects(
        ledger.reserve('t1', { preFlightEstimateUsd: 1, caps: DEFAULT_CAPS }),
        /in-flight reservation/,
      );
    } finally {
      await cleanup();
    }
  });

  it('rejects negative pre-flight estimate', async () => {
    const { ledger, cleanup } = await newSetup();
    try {
      await assert.rejects(
        ledger.reserve('t1', { preFlightEstimateUsd: -0.5, caps: DEFAULT_CAPS }),
        /finite non-negative/,
      );
    } finally {
      await cleanup();
    }
  });

  it('rejects NaN / Infinity inputs (Codex pass 2 CRITICAL #2)', async () => {
    const { ledger, cleanup } = await newSetup();
    try {
      // NaN slipping past the cap was the documented attack surface.
      await assert.rejects(
        ledger.reserve('t1', { preFlightEstimateUsd: Number.NaN, caps: DEFAULT_CAPS }),
        /finite non-negative/,
      );
      await assert.rejects(
        ledger.reserve('t2', {
          preFlightEstimateUsd: Number.POSITIVE_INFINITY,
          caps: DEFAULT_CAPS,
        }),
        /finite non-negative/,
      );
      // NaN in caps should also reject.
      await assert.rejects(
        ledger.reserve('t3', {
          preFlightEstimateUsd: 1,
          caps: { perRunUSD: Number.NaN, perSubagentUSD: 1 },
        }),
        /finite non-negative/,
      );
    } finally {
      await cleanup();
    }
  });

  it('rejects re-reserve of a released task_id (WARN #5)', async () => {
    // task_ids are immutable across their lifecycle; once released,
    // the same id cannot host a new reservation.
    const { ledger, cleanup } = await newSetup();
    try {
      await ledger.reserve('t1', { preFlightEstimateUsd: 1, caps: DEFAULT_CAPS });
      await ledger.release('t1', { actualCostUsd: 1 });
      await assert.rejects(
        ledger.reserve('t1', { preFlightEstimateUsd: 1, caps: DEFAULT_CAPS }),
        /cannot re-reserve/,
      );
    } finally {
      await cleanup();
    }
  });

  it('rejects USD values above the safe-integer micros range (Codex pass 3 WARN)', async () => {
    const { ledger, cleanup } = await newSetup();
    try {
      // MAX_USD ≈ $9.007e9. Anything above must reject; aggregate micros
      // could otherwise blow past Number.MAX_SAFE_INTEGER and break cap
      // comparisons.
      const tooBig = 1e10;
      await assert.rejects(
        ledger.reserve('t1', {
          preFlightEstimateUsd: tooBig,
          caps: { perRunUSD: 1e11, perSubagentUSD: 1e11 },
        }),
        /safe-integer micros range/,
      );
    } finally {
      await cleanup();
    }
  });

  it('halt is terminal — refuses further reserve on same task_id (Codex pass 2 CRITICAL #1)', async () => {
    const { eventsPath, ledger, cleanup } = await newSetup();
    try {
      const caps: BudgetCaps = { perRunUSD: 1, perSubagentUSD: 1 };
      await ledger.reserve('t1', { preFlightEstimateUsd: 1, caps });
      // t2 over-reserves → halt landed.
      await assert.rejects(
        ledger.reserve('t2', { preFlightEstimateUsd: 1, caps }),
        (err: Error) => err instanceof BudgetExceededError,
      );
      // Even if we expand the cap, t2 cannot resurrect under the same id.
      const expandedCaps: BudgetCaps = { perRunUSD: 100, perSubagentUSD: 1 };
      await assert.rejects(
        ledger.reserve('t2', { preFlightEstimateUsd: 1, caps: expandedCaps }),
        /terminally halted/,
      );
      // Other tasks under the new cap still work.
      await ledger.reserve('t3', { preFlightEstimateUsd: 1, caps: expandedCaps });
      const events = readEventLines(eventsPath);
      // t1 reserved, t2 halt, t3 reserved (t2's retry is rejected
      // pre-write — terminal_state errors throw BEFORE writeEvent).
      assert.equal(events.filter(e => e.event === 'task.budget_reserved').length, 2);
      assert.equal(events.filter(e => e.event === 'task.budget_halt').length, 1);
    } finally {
      await cleanup();
    }
  });

  it('concurrent callers cannot both over-reserve (atomic check+reserve)', async () => {
    const { eventsPath, ledger, cleanup } = await newSetup();
    try {
      const caps: BudgetCaps = { perRunUSD: 5, perSubagentUSD: 3 };
      // Five concurrent reservations of $1.50 each. Only THREE can fit
      // ($4.50 reserved, $0.50 remains; the 4th would need $1.50 with
      // only $0.50 left → halt). 5 attempts → 3 succeed, 2 halt.
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          ledger.reserve(`t${i}`, { preFlightEstimateUsd: 1.5, caps }),
        ),
      );
      const successes = results.filter(r => r.status === 'fulfilled').length;
      const failures = results.filter(r => r.status === 'rejected').length;
      assert.equal(successes, 3, 'exactly 3 reservations should fit');
      assert.equal(failures, 2);
      // Snapshot: 3 * $1.50 = $4.50
      assert.equal(ledger.snapshot().activeReservedTotal, 4.5);
      assert.equal(ledger.snapshot().committedTotal, 4.5);
      // Events: 3 reserved + 2 halt = 5
      const events = readEventLines(eventsPath);
      assert.equal(events.length, 5);
      const reservedCount = events.filter(e => e.event === 'task.budget_reserved').length;
      const haltCount = events.filter(e => e.event === 'task.budget_halt').length;
      assert.equal(reservedCount, 3);
      assert.equal(haltCount, 2);
    } finally {
      await cleanup();
    }
  });

  it('seq is monotonic across concurrent reserve attempts', async () => {
    const { eventsPath, ledger, cleanup } = await newSetup();
    try {
      const caps: BudgetCaps = { perRunUSD: 100, perSubagentUSD: 2 };
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          ledger.reserve(`t${i}`, { preFlightEstimateUsd: 1, caps }),
        ),
      );
      const events = readEventLines(eventsPath);
      assert.equal(events.length, 20);
      const seqs = events.map(e => e.seq);
      assert.deepEqual(
        [...seqs].sort((a, b) => a - b),
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
      // And no duplicates.
      assert.equal(new Set(seqs).size, 20);
    } finally {
      await cleanup();
    }
  });

  it('release does NOT free committed budget — preserves spent vs reserved (CRITICAL #2)', async () => {
    // Codex pass 1 CRITICAL #2: the naive `in_flight = reserved -
    // released_actual` model lets a $6 reservation released at $6 actual
    // free $6 under a $10 cap → another $6 reservation slips in → $12
    // committed. The fix preserves commitment via committedTotal =
    // spentTotal + activeReservedTotal.
    const { ledger, cleanup } = await newSetup();
    try {
      const caps: BudgetCaps = { perRunUSD: 10, perSubagentUSD: 6 };
      await ledger.reserve('t1', { preFlightEstimateUsd: 6, caps });
      await ledger.release('t1', { actualCostUsd: 6 });
      // After release: spent=$6, active=$0, committed=$6. Headroom=$4.
      const snap = ledger.snapshot();
      assert.equal(snap.spentTotal, 6);
      assert.equal(snap.activeReservedTotal, 0);
      assert.equal(snap.committedTotal, 6);
      // A new $6 reservation MUST halt — committed would be $12 > $10.
      await assert.rejects(
        ledger.reserve('t2', { preFlightEstimateUsd: 6, caps }),
        (err: Error) => err instanceof BudgetExceededError,
      );
    } finally {
      await cleanup();
    }
  });

  it('float-precision boundary: $0.1 + $0.2 reserves exactly $0.30 (WARN #6)', async () => {
    // Internal arithmetic uses integer micros so 0.1 + 0.2 sums to 0.3,
    // not 0.30000000000000004. This guards the cap check from
    // floating-point drift.
    const { eventsPath, ledger, cleanup } = await newSetup();
    try {
      const caps: BudgetCaps = { perRunUSD: 0.3, perSubagentUSD: 0.2 };
      await ledger.reserve('t1', { preFlightEstimateUsd: 0.1, caps });
      await ledger.reserve('t2', { preFlightEstimateUsd: 0.2, caps });
      const snap = ledger.snapshot();
      // committedTotal should be EXACTLY 0.3 once routed through micros.
      assert.equal(snap.committedTotal, 0.3);
      // A third $0.000001 reservation must halt (perRunUSD is fully
      // committed). Without integer-micro precision the sum could appear
      // as 0.30000000000000004 and either let this slip through or
      // (worse) halt earlier reservations.
      await assert.rejects(
        ledger.reserve('t3', { preFlightEstimateUsd: 0.000001, caps }),
        (err: Error) => err instanceof BudgetExceededError,
      );
      const events = readEventLines(eventsPath);
      // 2 reserved + 1 halt.
      assert.equal(events.length, 3);
      assert.equal(events[2]!.event, 'task.budget_halt');
    } finally {
      await cleanup();
    }
  });
});

describe('BudgetReservation.increaseReservation', () => {
  it('bumps reservation and writes task.budget_increased_reservation', async () => {
    const { eventsPath, ledger, cleanup } = await newSetup();
    try {
      await ledger.reserve('t1', { preFlightEstimateUsd: 1, caps: DEFAULT_CAPS });
      await ledger.increaseReservation('t1', {
        newReservedUsd: 2,
        reason: 'telemetry surge',
        caps: DEFAULT_CAPS,
      });
      const snap = ledger.snapshot();
      assert.equal(snap.activeReservedTotal, 2);
      assert.equal(snap.committedTotal, 2);
      assert.equal(snap.perTask.get('t1')?.reserved_usd, 2);
      const events = readEventLines(eventsPath);
      assert.equal(events.length, 2);
      assert.equal(events[1]!.event, 'task.budget_increased_reservation');
    } finally {
      await cleanup();
    }
  });

  it('treats newReservedUsd as ABSOLUTE, not delta (WARN #3)', async () => {
    // Reserve $2 → increase to $3 → increase to $5. Final commitment
    // must be $5 (the latest absolute value), NOT $2 + $3 + $5 = $10
    // (the delta misreading).
    const { ledger, cleanup } = await newSetup();
    try {
      const caps: BudgetCaps = { perRunUSD: 10, perSubagentUSD: 5 };
      await ledger.reserve('t1', { preFlightEstimateUsd: 2, caps });
      await ledger.increaseReservation('t1', {
        newReservedUsd: 3,
        reason: 'first bump',
        caps,
      });
      assert.equal(ledger.snapshot().committedTotal, 3);
      await ledger.increaseReservation('t1', {
        newReservedUsd: 5,
        reason: 'second bump',
        caps,
      });
      assert.equal(ledger.snapshot().committedTotal, 5);
      assert.equal(ledger.snapshot().perTask.get('t1')?.reserved_usd, 5);
    } finally {
      await cleanup();
    }
  });

  it('halts when bump would exceed perRunUSD', async () => {
    const { eventsPath, ledger, cleanup } = await newSetup();
    try {
      const caps: BudgetCaps = { perRunUSD: 5, perSubagentUSD: 3 };
      await ledger.reserve('t1', { preFlightEstimateUsd: 2, caps });
      await ledger.reserve('t2', { preFlightEstimateUsd: 2, caps });
      // Bumping t1 from 2 to 3 means active goes from 4 to 5; that fits.
      await ledger.increaseReservation('t1', {
        newReservedUsd: 3,
        reason: 'edge',
        caps,
      });
      // Bumping t2 from 2 to 3 would put active at 6 — over the $5 cap.
      await assert.rejects(
        ledger.increaseReservation('t2', {
          newReservedUsd: 3,
          reason: 'over-cap',
          caps,
        }),
        (err: Error) => err instanceof BudgetExceededError,
      );
      const events = readEventLines(eventsPath);
      // 2 reserved + 1 increase + 1 halt = 4
      assert.equal(events.length, 4);
      assert.equal(events[3]!.event, 'task.budget_halt');
    } finally {
      await cleanup();
    }
  });

  it('rejects bump that exceeds perSubagentUSD', async () => {
    const { ledger, cleanup } = await newSetup();
    try {
      await ledger.reserve('t1', { preFlightEstimateUsd: 1, caps: DEFAULT_CAPS });
      await assert.rejects(
        ledger.increaseReservation('t1', {
          newReservedUsd: 5,
          reason: 'over-subagent',
          caps: DEFAULT_CAPS,
        }),
        (err: Error) => err instanceof BudgetExceededError,
      );
    } finally {
      await cleanup();
    }
  });

  it('rejects non-increasing bump', async () => {
    const { ledger, cleanup } = await newSetup();
    try {
      await ledger.reserve('t1', { preFlightEstimateUsd: 2, caps: DEFAULT_CAPS });
      await assert.rejects(
        ledger.increaseReservation('t1', {
          newReservedUsd: 2,
          reason: 'no-op',
          caps: DEFAULT_CAPS,
        }),
        /must raise the cap/,
      );
      await assert.rejects(
        ledger.increaseReservation('t1', {
          newReservedUsd: 1,
          reason: 'downward',
          caps: DEFAULT_CAPS,
        }),
        /must raise the cap/,
      );
    } finally {
      await cleanup();
    }
  });

  it('rejects NaN / Infinity / negative inputs to increaseReservation (Codex pass 3 WARN)', async () => {
    const { ledger, cleanup } = await newSetup();
    try {
      await ledger.reserve('t1', { preFlightEstimateUsd: 1, caps: DEFAULT_CAPS });
      await assert.rejects(
        ledger.increaseReservation('t1', {
          newReservedUsd: Number.NaN,
          reason: 'r',
          caps: DEFAULT_CAPS,
        }),
        /finite non-negative/,
      );
      await assert.rejects(
        ledger.increaseReservation('t1', {
          newReservedUsd: Number.POSITIVE_INFINITY,
          reason: 'r',
          caps: DEFAULT_CAPS,
        }),
        /finite non-negative/,
      );
      await assert.rejects(
        ledger.increaseReservation('t1', {
          newReservedUsd: -1,
          reason: 'r',
          caps: DEFAULT_CAPS,
        }),
        /finite non-negative/,
      );
      // NaN in caps also rejects.
      await assert.rejects(
        ledger.increaseReservation('t1', {
          newReservedUsd: 2,
          reason: 'r',
          caps: { perRunUSD: Number.NaN, perSubagentUSD: 5 },
        }),
        /finite non-negative/,
      );
    } finally {
      await cleanup();
    }
  });

  it('release is allowed after increaseReservation halt — finalizes stranded reservation (Codex pass 3 CRITICAL #2)', async () => {
    // If increaseReservation triggers a halt, the task already has an
    // active reservation. release() MUST still be allowed so the
    // finalizer can clear activeReservedMicros — otherwise the run
    // permanently strands the reservation and blocks other tasks.
    const { eventsPath, ledger, cleanup } = await newSetup();
    try {
      const caps: BudgetCaps = { perRunUSD: 3, perSubagentUSD: 3 };
      await ledger.reserve('t1', { preFlightEstimateUsd: 2, caps });
      // Bump from $2 → $3.5 — exceeds perSubagentUSD ($3), pre-lock
      // throw, no halt. Use a different setup: bump that exceeds
      // perRunUSD instead.
      await ledger.reserve('t2', { preFlightEstimateUsd: 1, caps });
      // Now committed = $3 (cap). Bump t1 from $2 → $3 should halt (it
      // would push committed to $4 > $3).
      await assert.rejects(
        ledger.increaseReservation('t1', {
          newReservedUsd: 3,
          reason: 'over',
          caps,
        }),
        (err: Error) => err instanceof BudgetExceededError,
      );
      // t1 is now halted but still has an active $2 reservation. The
      // release MUST succeed and clear that active reservation.
      await ledger.release('t1', { actualCostUsd: 2 });
      const snap = ledger.snapshot();
      assert.equal(snap.spentTotal, 2, 't1 spent recorded');
      // Active = t2's still-active $1.
      assert.equal(snap.activeReservedTotal, 1);
      assert.equal(snap.committedTotal, 3);
      // And future reserve/increase on t1 still rejects (terminal).
      await assert.rejects(
        ledger.increaseReservation('t1', {
          newReservedUsd: 3,
          reason: 'after-release',
          caps,
        }),
        /no in-flight reservation|terminally halted/,
      );
      const events = readEventLines(eventsPath);
      // 2 reserved + 1 halt + 1 released
      assert.equal(events.filter(e => e.event === 'task.budget_reserved').length, 2);
      assert.equal(events.filter(e => e.event === 'task.budget_halt').length, 1);
      assert.equal(events.filter(e => e.event === 'task.budget_released').length, 1);
    } finally {
      await cleanup();
    }
  });

  it('rejects bump on a missing or already-released reservation', async () => {
    const { ledger, cleanup } = await newSetup();
    try {
      await assert.rejects(
        ledger.increaseReservation('ghost', {
          newReservedUsd: 1,
          reason: 'r',
          caps: DEFAULT_CAPS,
        }),
        /no in-flight reservation/,
      );
      await ledger.reserve('t1', { preFlightEstimateUsd: 1, caps: DEFAULT_CAPS });
      await ledger.release('t1', { actualCostUsd: 1 });
      await assert.rejects(
        ledger.increaseReservation('t1', {
          newReservedUsd: 2,
          reason: 'r',
          caps: DEFAULT_CAPS,
        }),
        /no in-flight reservation/,
      );
    } finally {
      await cleanup();
    }
  });
});

describe('BudgetReservation.release', () => {
  it('writes task.budget_released with positive delta when under budget', async () => {
    const { eventsPath, ledger, cleanup } = await newSetup();
    try {
      await ledger.reserve('t1', { preFlightEstimateUsd: 2, caps: DEFAULT_CAPS });
      await ledger.release('t1', { actualCostUsd: 1.25 });
      const snap = ledger.snapshot();
      // After release: spent=$1.25, active=$0, committed=$1.25.
      assert.equal(snap.spentTotal, 1.25);
      assert.equal(snap.activeReservedTotal, 0);
      assert.equal(snap.committedTotal, 1.25);
      const events = readEventLines(eventsPath);
      assert.equal(events.length, 2);
      const rel = events[1]! as Extract<RunEvent, { event: 'task.budget_released' }>;
      assert.equal(rel.actual_cost_usd, 1.25);
      assert.equal(rel.delta_vs_reservation_usd, 0.75);
    } finally {
      await cleanup();
    }
  });

  it('writes negative delta when over reservation (no halt — release is unconditional)', async () => {
    const { eventsPath, ledger, cleanup } = await newSetup();
    try {
      await ledger.reserve('t1', { preFlightEstimateUsd: 1, caps: DEFAULT_CAPS });
      await ledger.release('t1', { actualCostUsd: 1.6 });
      const events = readEventLines(eventsPath);
      const rel = events[1]! as Extract<RunEvent, { event: 'task.budget_released' }>;
      // Integer-micro arithmetic gives an exact -0.6, no float epsilon
      // tolerance needed.
      assert.equal(rel.delta_vs_reservation_usd, -0.6);
    } finally {
      await cleanup();
    }
  });

  it('rejects release on missing or already-released reservation', async () => {
    const { ledger, cleanup } = await newSetup();
    try {
      await assert.rejects(
        ledger.release('ghost', { actualCostUsd: 1 }),
        /no reservation found/,
      );
      await ledger.reserve('t1', { preFlightEstimateUsd: 1, caps: DEFAULT_CAPS });
      await ledger.release('t1', { actualCostUsd: 1 });
      await assert.rejects(
        ledger.release('t1', { actualCostUsd: 1 }),
        /already released/,
      );
    } finally {
      await cleanup();
    }
  });

  it('rejects negative actual cost', async () => {
    const { ledger, cleanup } = await newSetup();
    try {
      await ledger.reserve('t1', { preFlightEstimateUsd: 1, caps: DEFAULT_CAPS });
      await assert.rejects(
        ledger.release('t1', { actualCostUsd: -0.5 }),
        /finite non-negative/,
      );
    } finally {
      await cleanup();
    }
  });

  it('rejects NaN actual cost (Codex pass 2 CRITICAL #2)', async () => {
    const { ledger, cleanup } = await newSetup();
    try {
      await ledger.reserve('t1', { preFlightEstimateUsd: 1, caps: DEFAULT_CAPS });
      await assert.rejects(
        ledger.release('t1', { actualCostUsd: Number.NaN }),
        /finite non-negative/,
      );
    } finally {
      await cleanup();
    }
  });
});

describe('BudgetReservation cross-instance (CRITICAL #1 + WARN #5)', () => {
  it('second instance sees first instance reservation via on-disk replay', async () => {
    // Two BudgetReservation instances backed by independent
    // SerializedWriters pointed at the same events.ndjson. After
    // instance A reserves, instance B's snapshot is stale (cache only
    // updates on its own mutations) — but the next mutation on B
    // re-replays disk under the lock and observes A's reservation.
    const { eventsPath } = tmpRun();
    const writerA = await SerializedWriter.create({
      eventsNdjsonPath: eventsPath,
      writerId: testWriterId,
      pollIntervalMs: 1,
      maxBlockingAttempts: 1000,
    });
    const writerB = await SerializedWriter.create({
      eventsNdjsonPath: eventsPath,
      writerId: { ...testWriterId, pid: testWriterId.pid + 1 },
      pollIntervalMs: 1,
      maxBlockingAttempts: 1000,
    });
    try {
      const caps: BudgetCaps = { perRunUSD: 5, perSubagentUSD: 3 };
      const ledgerA = new BudgetReservation(writerA);
      const ledgerB = new BudgetReservation(writerB);

      // A reserves $3.
      await ledgerA.reserve('tA', { preFlightEstimateUsd: 3, caps });

      // B then tries to reserve $3 — only $2 remaining. The disk-replay
      // inside the lock MUST see A's appended reservation and halt.
      await assert.rejects(
        ledgerB.reserve('tB', { preFlightEstimateUsd: 3, caps }),
        (err: Error) => err instanceof BudgetExceededError,
      );

      // The halt landed on disk.
      const events = readEventLines(eventsPath);
      assert.equal(events.length, 2);
      assert.equal(events[0]!.event, 'task.budget_reserved');
      assert.equal(events[1]!.event, 'task.budget_halt');

      // After the failed reserve, ledgerB's cache was refreshed from
      // disk inside the lock — its snapshot should now reflect A's
      // reservation.
      const snapB = ledgerB.snapshot();
      assert.equal(snapB.activeReservedTotal, 3);
      assert.equal(snapB.committedTotal, 3);
      assert.ok(snapB.perTask.has('tA'));
    } finally {
      await writerA.close();
      await writerB.close();
    }
  });

  it('races between two instances produce a consistent committed total', async () => {
    const { eventsPath } = tmpRun();
    const writerA = await SerializedWriter.create({
      eventsNdjsonPath: eventsPath,
      writerId: testWriterId,
      pollIntervalMs: 1,
      maxBlockingAttempts: 1000,
    });
    const writerB = await SerializedWriter.create({
      eventsNdjsonPath: eventsPath,
      writerId: { ...testWriterId, pid: testWriterId.pid + 2 },
      pollIntervalMs: 1,
      maxBlockingAttempts: 1000,
    });
    try {
      const caps: BudgetCaps = { perRunUSD: 5, perSubagentUSD: 2 };
      const ledgerA = new BudgetReservation(writerA);
      const ledgerB = new BudgetReservation(writerB);

      // 10 concurrent reservations of $1, split across the two
      // instances. perRun=$5 → exactly 5 should succeed.
      const tasks: Promise<void>[] = [];
      for (let i = 0; i < 10; i++) {
        const ledger = i % 2 === 0 ? ledgerA : ledgerB;
        const taskId = `t${i}`;
        tasks.push(
          ledger.reserve(taskId, { preFlightEstimateUsd: 1, caps }).catch(() => {}),
        );
      }
      await Promise.all(tasks);

      // Read events from disk — must show exactly 5 reservations + 5
      // halts and never exceed perRunUSD.
      const events = readEventLines(eventsPath);
      const reserved = events.filter(e => e.event === 'task.budget_reserved').length;
      const halted = events.filter(e => e.event === 'task.budget_halt').length;
      assert.equal(reserved, 5, 'exactly 5 reservations fit under $5 cap');
      assert.equal(halted, 5);
    } finally {
      await writerA.close();
      await writerB.close();
    }
  });
});

describe('BudgetReservation.replayFromEvents (resume)', () => {
  it('reconstructs totals from events.ndjson alone', async () => {
    const { eventsPath, ledger, cleanup } = await newSetup();
    try {
      const caps: BudgetCaps = { perRunUSD: 20, perSubagentUSD: 5 };
      await ledger.reserve('t1', { preFlightEstimateUsd: 2, caps });
      await ledger.reserve('t2', { preFlightEstimateUsd: 3, caps });
      await ledger.increaseReservation('t1', {
        newReservedUsd: 4,
        reason: 'bump',
        caps,
      });
      await ledger.release('t2', { actualCostUsd: 2.5 });
      await cleanup();

      // Fresh replay from disk.
      const summary = BudgetReservation.replayFromEvents(eventsPath);
      // spentTotal = $2.5 (t2 released at $2.50).
      assert.equal(summary.spentTotal, 2.5);
      // activeReservedTotal = $4 (t1 latest reservation, t2 released).
      assert.equal(summary.activeReservedTotal, 4);
      // committedTotal = spent + active = $6.5.
      assert.equal(summary.committedTotal, 6.5);
      // Per-task state.
      assert.equal(summary.perTask.get('t1')?.reserved_usd, 4);
      assert.equal(summary.perTask.get('t1')?.released, false);
      assert.equal(summary.perTask.get('t2')?.reserved_usd, 3);
      assert.equal(summary.perTask.get('t2')?.released, true);
      assert.equal(summary.perTask.get('t2')?.actual_cost_usd, 2.5);
    } finally {
      // Already cleaned above; safe to call again.
      await cleanup();
    }
  });

  it('matches in-memory snapshot after hydrateFromEvents', async () => {
    const setup1 = await newSetup();
    const caps: BudgetCaps = { perRunUSD: 50, perSubagentUSD: 10 };
    await setup1.ledger.reserve('alpha', { preFlightEstimateUsd: 5, caps });
    await setup1.ledger.reserve('beta', { preFlightEstimateUsd: 7, caps });
    await setup1.ledger.release('alpha', { actualCostUsd: 4 });
    await setup1.ledger.increaseReservation('beta', {
      newReservedUsd: 9,
      reason: 'r',
      caps,
    });
    await setup1.cleanup();

    // New writer + ledger pointed at the same events.ndjson — simulating
    // a resume after restart.
    const writer2 = await SerializedWriter.create({
      eventsNdjsonPath: setup1.eventsPath,
      writerId: testWriterId,
    });
    const ledger2 = new BudgetReservation(writer2);
    await ledger2.hydrateFromEvents(setup1.eventsPath);
    const snap = ledger2.snapshot();
    // spentTotal = $4 (alpha released at $4).
    assert.equal(snap.spentTotal, 4);
    // activeReservedTotal = $9 (beta bumped to $9; alpha released).
    assert.equal(snap.activeReservedTotal, 9);
    // committedTotal = $13.
    assert.equal(snap.committedTotal, 13);
    assert.equal(snap.perTask.get('alpha')?.released, true);
    assert.equal(snap.perTask.get('beta')?.reserved_usd, 9);
    await writer2.close();
  });

  it('returns empty summary on missing or empty events.ndjson', () => {
    const empty = BudgetReservation.replayFromEvents('/nonexistent/path');
    assert.equal(empty.spentTotal, 0);
    assert.equal(empty.activeReservedTotal, 0);
    assert.equal(empty.committedTotal, 0);
    assert.equal(empty.perTask.size, 0);

    const { eventsPath } = tmpRun();
    fs.writeFileSync(eventsPath, '');
    const e2 = BudgetReservation.replayFromEvents(eventsPath);
    assert.equal(e2.committedTotal, 0);
    assert.equal(e2.perTask.size, 0);
  });

  it('replay ignores task events that do not affect budget state', async () => {
    const setup = await newSetup();
    const caps: BudgetCaps = { perRunUSD: 10, perSubagentUSD: 5 };
    await setup.ledger.reserve('t1', { preFlightEstimateUsd: 1, caps });
    // Append a non-budget task event directly via the writer.
    await setup.writer.writeEvent({
      event: 'task.started',
      task_id: 't1',
      worktree_path: '/tmp/wt',
      branch: 'b',
      base_sha: 'a'.repeat(40),
      subagent_id: 's',
      dispatched_at: new Date().toISOString(),
      preflight_cost_estimate_usd: 1,
    });
    await setup.cleanup();

    const summary = BudgetReservation.replayFromEvents(setup.eventsPath);
    assert.equal(summary.spentTotal, 0);
    assert.equal(summary.activeReservedTotal, 1);
    assert.equal(summary.committedTotal, 1);
  });

  it('throws on corrupt ledger: task.budget_reserved after task.budget_halt (Codex pass 3 CRITICAL #1)', async () => {
    // Hand-write an events.ndjson with halt followed by a later
    // reserved event for the same task. Replay MUST fail closed
    // rather than silently apply the post-halt mutation.
    const { eventsPath } = tmpRun();
    const halt = JSON.stringify({
      schema_version: 1,
      seq: 1,
      ts: '2026-05-20T00:00:00.000Z',
      runId: 'r1',
      writerId: testWriterId,
      event: 'task.budget_halt',
      task_id: 't1',
      budget_remaining_usd: 0,
      preflight_estimate_usd: 1,
    });
    const reserved = JSON.stringify({
      schema_version: 1,
      seq: 2,
      ts: '2026-05-20T00:00:01.000Z',
      runId: 'r1',
      writerId: testWriterId,
      event: 'task.budget_reserved',
      task_id: 't1',
      reserved_usd: 1,
      run_budget_remaining_after_reservation_usd: 0,
    });
    fs.writeFileSync(eventsPath, `${halt}\n${reserved}\n`);
    assert.throws(
      () => BudgetReservation.replayFromEvents(eventsPath),
      /AFTER task\.budget_halt/,
    );
  });

  it('throws on corrupt ledger: task.budget_increased_reservation after halt', async () => {
    const { eventsPath } = tmpRun();
    const reserved = JSON.stringify({
      schema_version: 1,
      seq: 1,
      ts: '2026-05-20T00:00:00.000Z',
      runId: 'r1',
      writerId: testWriterId,
      event: 'task.budget_reserved',
      task_id: 't1',
      reserved_usd: 1,
      run_budget_remaining_after_reservation_usd: 0,
    });
    const halt = JSON.stringify({
      schema_version: 1,
      seq: 2,
      ts: '2026-05-20T00:00:01.000Z',
      runId: 'r1',
      writerId: testWriterId,
      event: 'task.budget_halt',
      task_id: 't1',
      budget_remaining_usd: 0,
      preflight_estimate_usd: 1,
    });
    const increased = JSON.stringify({
      schema_version: 1,
      seq: 3,
      ts: '2026-05-20T00:00:02.000Z',
      runId: 'r1',
      writerId: testWriterId,
      event: 'task.budget_increased_reservation',
      task_id: 't1',
      prior_reserved_usd: 1,
      new_reserved_usd: 2,
      reason: 'bug',
    });
    fs.writeFileSync(eventsPath, `${reserved}\n${halt}\n${increased}\n`);
    assert.throws(
      () => BudgetReservation.replayFromEvents(eventsPath),
      /AFTER task\.budget_halt/,
    );
  });

  it('replay ALLOWS task.budget_released after halt (legit finalizer path)', async () => {
    // The pass-3 CRITICAL fix: halt does NOT block release at runtime
    // (otherwise active reservations strand). Replay must therefore
    // also allow the released event to land after halt for the same
    // task — that's the legitimate finalizer pattern.
    const { eventsPath } = tmpRun();
    const reserved = JSON.stringify({
      schema_version: 1,
      seq: 1,
      ts: '2026-05-20T00:00:00.000Z',
      runId: 'r1',
      writerId: testWriterId,
      event: 'task.budget_reserved',
      task_id: 't1',
      reserved_usd: 2,
      run_budget_remaining_after_reservation_usd: 1,
    });
    const halt = JSON.stringify({
      schema_version: 1,
      seq: 2,
      ts: '2026-05-20T00:00:01.000Z',
      runId: 'r1',
      writerId: testWriterId,
      event: 'task.budget_halt',
      task_id: 't1',
      budget_remaining_usd: 1,
      preflight_estimate_usd: 2,
    });
    const released = JSON.stringify({
      schema_version: 1,
      seq: 3,
      ts: '2026-05-20T00:00:02.000Z',
      runId: 'r1',
      writerId: testWriterId,
      event: 'task.budget_released',
      task_id: 't1',
      actual_cost_usd: 2,
      delta_vs_reservation_usd: 0,
    });
    fs.writeFileSync(eventsPath, `${reserved}\n${halt}\n${released}\n`);
    const summary = BudgetReservation.replayFromEvents(eventsPath);
    assert.equal(summary.spentTotal, 2);
    assert.equal(summary.activeReservedTotal, 0);
    assert.equal(summary.perTask.get('t1')?.released, true);
  });

  it('throws on corrupt ledger: duplicate task.budget_reserved (bugbot pass 3)', async () => {
    const { eventsPath } = tmpRun();
    const reserved = (seq: number) =>
      JSON.stringify({
        schema_version: 1,
        seq,
        ts: `2026-05-20T00:00:0${seq}.000Z`,
        runId: 'r1',
        writerId: testWriterId,
        event: 'task.budget_reserved',
        task_id: 't1',
        reserved_usd: 1,
        run_budget_remaining_after_reservation_usd: 0,
      });
    fs.writeFileSync(eventsPath, `${reserved(1)}\n${reserved(2)}\n`);
    assert.throws(
      () => BudgetReservation.replayFromEvents(eventsPath),
      /duplicate task\.budget_reserved/,
    );
  });

  it('throws on corrupt ledger: duplicate task.budget_released (bugbot pass 3)', async () => {
    const { eventsPath } = tmpRun();
    const reserved = JSON.stringify({
      schema_version: 1,
      seq: 1,
      ts: '2026-05-20T00:00:00.000Z',
      runId: 'r1',
      writerId: testWriterId,
      event: 'task.budget_reserved',
      task_id: 't1',
      reserved_usd: 1,
      run_budget_remaining_after_reservation_usd: 0,
    });
    const released = (seq: number) =>
      JSON.stringify({
        schema_version: 1,
        seq,
        ts: `2026-05-20T00:00:0${seq}.000Z`,
        runId: 'r1',
        writerId: testWriterId,
        event: 'task.budget_released',
        task_id: 't1',
        actual_cost_usd: 1,
        delta_vs_reservation_usd: 0,
      });
    fs.writeFileSync(eventsPath, `${reserved}\n${released(2)}\n${released(3)}\n`);
    assert.throws(
      () => BudgetReservation.replayFromEvents(eventsPath),
      /duplicate task\.budget_released/,
    );
  });

  it('tolerates truncated-tail by stopping at the last valid line', async () => {
    const setup = await newSetup();
    const caps: BudgetCaps = { perRunUSD: 10, perSubagentUSD: 5 };
    await setup.ledger.reserve('t1', { preFlightEstimateUsd: 1, caps });
    await setup.ledger.reserve('t2', { preFlightEstimateUsd: 1, caps });
    await setup.cleanup();
    // Corrupt the file by appending a partial JSON line.
    fs.appendFileSync(setup.eventsPath, '{"event":"task.budget_reser');
    // Replay should still recover t1 + t2.
    const summary = BudgetReservation.replayFromEvents(setup.eventsPath);
    assert.equal(summary.committedTotal, 2);
    assert.equal(summary.perTask.size, 2);
  });
});
