// tests/concurrent-dispatch/budget-reservation.test.ts
//
// Tests for the budget reservation ledger (PR 3/6, v7.11.0). Covers issue
// #190 acceptance bullets:
//
//   * `reserve()` is atomic: two concurrent callers cannot both pass the
//     budget check
//   * `task.budget_increased_reservation` re-checks `perRunUSD` and halts
//     on overage
//   * `perSubagentUSD` enforced as HARD cap: dispatch rejected if
//     `preFlightEstimate > perSubagentUSD`
//   * Resume replay: `reserved_total = sum(reserved +
//     increased_reservation) - sum(released)` reconstructs state from
//     events.ndjson alone

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
      assert.equal(snap.reservedTotal, 1.5);
      assert.equal(snap.releasedTotal, 0);
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
      assert.equal(ledger.snapshot().reservedTotal, 0);
    } finally {
      await cleanup();
    }
  });

  it('emits task.budget_halt when perRunUSD would be exceeded', async () => {
    const { eventsPath, ledger, cleanup } = await newSetup();
    try {
      // Use the full budget on t1.
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
        /must be >= 0/,
      );
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
      assert.equal(ledger.snapshot().reservedTotal, 4.5);
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
      assert.equal(snap.reservedTotal, 2);
      assert.equal(snap.perTask.get('t1')?.reserved_usd, 2);
      const events = readEventLines(eventsPath);
      assert.equal(events.length, 2);
      assert.equal(events[1]!.event, 'task.budget_increased_reservation');
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
      // Bumping t1 from 2 to 3 means in_flight goes from 4 to 5; that fits.
      await ledger.increaseReservation('t1', {
        newReservedUsd: 3,
        reason: 'edge',
        caps,
      });
      // Bumping t2 from 2 to 3 would put in_flight at 6 — over the $5 cap.
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
      assert.equal(snap.reservedTotal, 2);
      assert.equal(snap.releasedTotal, 1.25);
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
      // floating-point comparison — released $1 reservation against $1.6 actual,
      // delta = 1 - 1.6 = -0.6 ± float epsilon.
      assert.ok(
        Math.abs(rel.delta_vs_reservation_usd - -0.6) < 1e-9,
        `expected ~-0.6, got ${rel.delta_vs_reservation_usd}`,
      );
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
        /actual cost must be >= 0/,
      );
    } finally {
      await cleanup();
    }
  });
});

describe('BudgetReservation.replayFromEvents (resume)', () => {
  it('reconstructs reservedTotal and releasedTotal from events.ndjson alone', async () => {
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
      // reserved_total = 2 (initial t1) + 3 (initial t2) + 2 (bump t1) = 7
      assert.equal(summary.reservedTotal, 7);
      // released_total = 2.5 (t2)
      assert.equal(summary.releasedTotal, 2.5);
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
    // reserved_total = 5 (alpha) + 7 (beta initial) + 2 (beta bump) = 14
    assert.equal(snap.reservedTotal, 14);
    // released_total = 4
    assert.equal(snap.releasedTotal, 4);
    assert.equal(snap.perTask.get('alpha')?.released, true);
    assert.equal(snap.perTask.get('beta')?.reserved_usd, 9);
    await writer2.close();
  });

  it('returns empty summary on missing or empty events.ndjson', () => {
    const empty = BudgetReservation.replayFromEvents('/nonexistent/path');
    assert.equal(empty.reservedTotal, 0);
    assert.equal(empty.releasedTotal, 0);
    assert.equal(empty.perTask.size, 0);

    const { eventsPath } = tmpRun();
    fs.writeFileSync(eventsPath, '');
    const e2 = BudgetReservation.replayFromEvents(eventsPath);
    assert.equal(e2.reservedTotal, 0);
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
    assert.equal(summary.reservedTotal, 1);
    assert.equal(summary.releasedTotal, 0);
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
    assert.equal(summary.reservedTotal, 2);
    assert.equal(summary.perTask.size, 2);
  });
});
