// tests/run-state/serialized-writer.test.ts
//
// Tests for the per-run serialized event writer (PR 3/6, v7.11.0). Covers
// issue #190 acceptance bullets:
//
//   * Serialized writer holds exclusive lock for the (encode → write →
//     fsync) critical section
//   * Concurrent NDJSON append test: 100 simulated writers, verify every
//     line in the resulting file parses as valid JSON
//   * Exception inside the wrapped writer fn still releases the lock
//     (try/finally pattern, same as withRepoLock)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SerializedWriter,
  writerLockPathFor,
} from '../../src/core/run-state/serialized-writer.ts';
import type { RunEvent, WriterId } from '../../src/core/run-state/types.ts';

const testWriterId: WriterId = { pid: process.pid, hostHash: 'test-host' };

function tmpRun(): { runDir: string; eventsPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serialized-writer-'));
  return { runDir: dir, eventsPath: path.join(dir, 'events.ndjson') };
}

async function withWriter<T>(
  eventsNdjsonPath: string,
  fn: (w: SerializedWriter) => Promise<T>,
): Promise<T> {
  const w = await SerializedWriter.create({
    eventsNdjsonPath,
    writerId: testWriterId,
    pollIntervalMs: 1,
    maxBlockingAttempts: 1000,
  });
  try {
    return await fn(w);
  } finally {
    await w.close();
  }
}

describe('SerializedWriter', () => {
  it('creates events file and lock target on init', async () => {
    const { eventsPath } = tmpRun();
    assert.equal(fs.existsSync(eventsPath), false);
    assert.equal(fs.existsSync(writerLockPathFor(eventsPath)), false);

    await withWriter(eventsPath, async () => {
      assert.equal(fs.existsSync(eventsPath), true);
      assert.equal(fs.existsSync(writerLockPathFor(eventsPath)), true);
    });
  });

  it('appends an event and fills in envelope fields', async () => {
    const { eventsPath } = tmpRun();
    await withWriter(eventsPath, async w => {
      const ev = await w.writeEvent({
        event: 'task.started',
        task_id: 't1',
        worktree_path: '/tmp/wt',
        branch: 'autopilot/x/t1',
        base_sha: 'a'.repeat(40),
        subagent_id: 'sa-1',
        dispatched_at: new Date().toISOString(),
        preflight_cost_estimate_usd: 0.5,
      });
      assert.equal(ev.event, 'task.started');
      assert.equal(ev.seq, 1);
      assert.equal(ev.writerId.pid, process.pid);
      assert.equal(ev.schema_version, 2);
      assert.ok(ev.ts.length > 0);
    });

    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as RunEvent;
    assert.equal(parsed.event, 'task.started');
  });

  it('assigns monotonic seq across sequential writes', async () => {
    const { eventsPath } = tmpRun();
    await withWriter(eventsPath, async w => {
      for (let i = 0; i < 10; i++) {
        await w.writeEvent({
          event: 'task.budget_reserved',
          task_id: `t${i}`,
          reserved_usd: 0.1,
          run_budget_remaining_after_reservation_usd: 100 - 0.1 * (i + 1),
        });
      }
    });
    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 10);
    for (let i = 0; i < 10; i++) {
      const parsed = JSON.parse(lines[i]!) as RunEvent;
      assert.equal(parsed.seq, i + 1, `line ${i} seq mismatch`);
    }
  });

  it('concurrent appenders produce 100 complete JSON lines (no partial writes)', async () => {
    const { eventsPath } = tmpRun();
    await withWriter(eventsPath, async w => {
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          w.writeEvent({
            event: 'task.started',
            task_id: `t${i}`,
            worktree_path: `/tmp/wt-${i}`,
            branch: `autopilot/x/t${i}`,
            base_sha: 'b'.repeat(40),
            subagent_id: `sa-${i}`,
            dispatched_at: new Date().toISOString(),
            preflight_cost_estimate_usd: 0.01,
          }),
        ),
      );
    });
    const raw = fs.readFileSync(eventsPath, 'utf8');
    assert.ok(raw.endsWith('\n'), 'file must end with newline');
    const lines = raw.slice(0, -1).split('\n');
    assert.equal(lines.length, 100, 'must have exactly 100 lines');
    // Every line parses; no partial-write interleave.
    const taskIdsSeen = new Set<string>();
    const seqsSeen = new Set<number>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as Extract<RunEvent, { event: 'task.started' }>;
      assert.equal(parsed.event, 'task.started');
      taskIdsSeen.add(parsed.task_id);
      seqsSeen.add(parsed.seq);
    }
    assert.equal(taskIdsSeen.size, 100, 'every task_id must be unique');
    assert.equal(seqsSeen.size, 100, 'every seq must be unique');
    // Verify seqs are exactly 1..100 (monotonic, no gaps, no dupes).
    for (let i = 1; i <= 100; i++) {
      assert.ok(seqsSeen.has(i), `missing seq ${i}`);
    }
  });

  it('exception inside withExclusive still releases the lock', async () => {
    const { eventsPath } = tmpRun();
    await withWriter(eventsPath, async w => {
      // First call throws; should release the lock.
      await assert.rejects(
        w.withExclusive(async () => {
          throw new Error('boom');
        }),
        /boom/,
      );

      // Second call should be able to acquire — if the lock were stuck, it
      // would block until maxBlockingAttempts and throw lock_held.
      const ev = await w.writeEvent({
        event: 'task.budget_released',
        task_id: 't1',
        actual_cost_usd: 0.25,
        delta_vs_reservation_usd: 0.05,
      });
      assert.equal(ev.event, 'task.budget_released');
    });
  });

  it('exception inside writeEvent still releases the lock', async () => {
    const { eventsPath } = tmpRun();
    const w = await SerializedWriter.create({
      eventsNdjsonPath: eventsPath,
      writerId: testWriterId,
      pollIntervalMs: 1,
      maxBlockingAttempts: 1000,
    });
    try {
      await w.close();
      // writeEvent after close should throw a guardrail error AND not
      // hold the lock open (we never acquired it).
      await assert.rejects(
        w.writeEvent({
          event: 'task.started',
          task_id: 't1',
          worktree_path: '/tmp',
          branch: 'x',
          base_sha: 'a'.repeat(40),
          subagent_id: 's',
          dispatched_at: new Date().toISOString(),
          preflight_cost_estimate_usd: 0.1,
        }),
        /after close/,
      );
    } finally {
      await w.close();
    }
  });

  it('withExclusive composes read + write atomically', async () => {
    const { eventsPath } = tmpRun();
    await withWriter(eventsPath, async w => {
      await w.withExclusive(async ({ writeEvent, readMaxSeq, eventsNdjsonPath }) => {
        assert.equal(readMaxSeq(), 0);
        assert.equal(eventsNdjsonPath, eventsPath);
        await writeEvent({
          event: 'task.budget_reserved',
          task_id: 't1',
          reserved_usd: 1.0,
          run_budget_remaining_after_reservation_usd: 99,
        });
        assert.equal(readMaxSeq(), 1);
        await writeEvent({
          event: 'task.budget_released',
          task_id: 't1',
          actual_cost_usd: 0.9,
          delta_vs_reservation_usd: 0.1,
        });
        assert.equal(readMaxSeq(), 2);
      });
    });
    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
  });

  it('close is idempotent', async () => {
    const { eventsPath } = tmpRun();
    const w = await SerializedWriter.create({
      eventsNdjsonPath: eventsPath,
      writerId: testWriterId,
    });
    await w.close();
    await w.close(); // no throw
  });

  it('rejects writes after close', async () => {
    const { eventsPath } = tmpRun();
    const w = await SerializedWriter.create({
      eventsNdjsonPath: eventsPath,
      writerId: testWriterId,
    });
    await w.close();
    await assert.rejects(
      w.writeEvent({
        event: 'task.budget_halt',
        task_id: 't',
        budget_remaining_usd: 0,
        preflight_estimate_usd: 1,
      }),
    );
    await assert.rejects(w.withExclusive(async () => 1));
  });

  it('writerLockPathFor returns sibling path, not the data file itself', () => {
    const p = writerLockPathFor('/tmp/run-x/events.ndjson');
    assert.notEqual(p, '/tmp/run-x/events.ndjson');
    assert.ok(p.startsWith('/tmp/run-x/events.ndjson'));
    assert.ok(p.endsWith('.writer.lock'));
  });

  it('sweeps stale lock dirs left by crashed prior process (bugbot pass 3)', async () => {
    // Simulate a crashed process: the lock dir `<lockPath>.lock` exists
    // but no live owner. init() must clean it so the next acquire
    // doesn't spin to timeout. (Pre-fix, `stale: 0` was misread by
    // proper-lockfile as `!0 → truthy` and treated every lock as stale,
    // OR — depending on version — never timed out and blocked all
    // future writes for 20 minutes.)
    const { eventsPath } = tmpRun();
    const lockPath = `${eventsPath}.writer.lock`;
    const staleLockDir = `${lockPath}.lock`;
    fs.mkdirSync(staleLockDir, { recursive: true });
    fs.writeFileSync(path.join(staleLockDir, 'pid'), '999999');

    // init() must sweep the stale dir; lock acquire should succeed
    // immediately rather than spinning to timeout.
    const w = await SerializedWriter.create({
      eventsNdjsonPath: eventsPath,
      writerId: testWriterId,
      pollIntervalMs: 1,
      maxBlockingAttempts: 10,
    });
    try {
      await w.writeEvent({
        event: 'task.budget_halt',
        task_id: 't1',
        budget_remaining_usd: 0,
        preflight_estimate_usd: 1,
      });
      assert.ok(true, 'writeEvent succeeded — stale lock was swept');
    } finally {
      await w.close();
    }
  });
});
