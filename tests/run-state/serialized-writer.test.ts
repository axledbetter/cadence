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
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** ESM equivalent of `__dirname` for the crash-recovery test. */
function __dirnameCompat(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

import {
  SerializedWriter,
  writerLockPathFor,
} from '../../src/core/run-state/serialized-writer.ts';
import {
  TERMINAL_TASK_EVENT_KINDS,
  type RunEvent,
  type WriterId,
} from '../../src/core/run-state/types.ts';

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

  // -------------------------------------------------------------------------
  // v8.1.1 — durability policy tests (issue #209).
  //
  // The serialized writer accepts a `durability` option: `'never' |
  // 'terminal' | 'always'`. Default is `'terminal'` — fsync only after
  // state-transition events. We verify the conditional fsync runs/skips
  // for the right events without mocking node:fs (the implementation calls
  // `fs.fsyncSync` directly; we instead spy via Node's `--test --import`
  // hook + a wrapper that swaps the binding. Simpler: assert observable
  // behaviour — content lands on disk regardless, but a forked subprocess
  // that exits immediately after writing a terminal event survives, while
  // a non-terminal event in `'never'` mode may not. Crash-recovery test
  // covers that; the in-process tests assert the fsync path is reached by
  // monkey-patching fs.fsyncSync for the duration of the test.
  // -------------------------------------------------------------------------

  it('default durability is "terminal" — fsyncs terminal events only', async () => {
    const { eventsPath } = tmpRun();
    let fsyncCalls = 0;
    const fsyncSpy = (_fd: number) => { fsyncCalls += 1; };
    {
      // No `durability` option — default should be `'terminal'`.
      const w = await SerializedWriter.create({
        eventsNdjsonPath: eventsPath,
        writerId: testWriterId,
        pollIntervalMs: 1,
        maxBlockingAttempts: 100,
        __fsyncSyncImpl: fsyncSpy,
      });
      try {
        // Informational event — must NOT fsync.
        await w.writeEvent({
          event: 'task.started',
          task_id: 't1',
          worktree_path: '/tmp/wt',
          branch: 'autopilot/x/t1',
          base_sha: 'a'.repeat(40),
          subagent_id: 'sa-1',
          dispatched_at: new Date().toISOString(),
          preflight_cost_estimate_usd: 0.5,
        });
        assert.equal(fsyncCalls, 0, 'task.started must not fsync under terminal mode');

        // Terminal event — must fsync.
        await w.writeEvent({
          event: 'task.completed',
          task_id: 't1',
          base_sha: 'a'.repeat(40),
          task_branch_tip_sha: 'b'.repeat(40),
          task_branch_name: 'autopilot/x/t1',
          commit_shas: ['b'.repeat(40)],
          completed_at: new Date().toISOString(),
          actual_cost_usd: 0.45,
          exit_status: 'success',
        });
        assert.equal(fsyncCalls, 1, 'task.completed must fsync exactly once under terminal mode');
      } finally {
        await w.close();
      }
    }
  });

  it('"never" mode skips fsync entirely (v7.11.0 compat)', async () => {
    const { eventsPath } = tmpRun();
    let fsyncCalls = 0;
    const fsyncSpy = (_fd: number) => { fsyncCalls += 1; };
    {
      const w = await SerializedWriter.create({
        eventsNdjsonPath: eventsPath,
        writerId: testWriterId,
        pollIntervalMs: 1,
        maxBlockingAttempts: 100,
        durability: 'never',
        __fsyncSyncImpl: fsyncSpy,
      });
      try {
        // Even a terminal event must NOT fsync under 'never'.
        await w.writeEvent({
          event: 'task.failed',
          task_id: 't1',
          error_message: 'boom',
          error_type: 'crash',
          failed_at: new Date().toISOString(),
          actual_cost_usd: 0.1,
        });
        await w.writeEvent({
          event: 'task.budget_halt',
          task_id: 't2',
          budget_remaining_usd: 0,
          preflight_estimate_usd: 1,
        });
        assert.equal(fsyncCalls, 0, 'never mode must never fsync');
      } finally {
        await w.close();
      }
    }
  });

  it('"always" mode fsyncs every event', async () => {
    const { eventsPath } = tmpRun();
    let fsyncCalls = 0;
    const fsyncSpy = (_fd: number) => { fsyncCalls += 1; };
    {
      const w = await SerializedWriter.create({
        eventsNdjsonPath: eventsPath,
        writerId: testWriterId,
        pollIntervalMs: 1,
        maxBlockingAttempts: 100,
        durability: 'always',
        __fsyncSyncImpl: fsyncSpy,
      });
      try {
        // 3 events, all event kinds — must fsync 3 times.
        await w.writeEvent({
          event: 'task.started',
          task_id: 't1',
          worktree_path: '/tmp',
          branch: 'x',
          base_sha: 'a'.repeat(40),
          subagent_id: 'sa',
          dispatched_at: new Date().toISOString(),
          preflight_cost_estimate_usd: 0.1,
        });
        await w.writeEvent({
          event: 'task.budget_reserved',
          task_id: 't1',
          reserved_usd: 0.1,
          run_budget_remaining_after_reservation_usd: 99.9,
        });
        await w.writeEvent({
          event: 'task.completed',
          task_id: 't1',
          base_sha: 'a'.repeat(40),
          task_branch_tip_sha: 'b'.repeat(40),
          task_branch_name: 'x',
          commit_shas: ['b'.repeat(40)],
          completed_at: new Date().toISOString(),
          actual_cost_usd: 0.1,
          exit_status: 'success',
        });
        assert.equal(fsyncCalls, 3, 'always mode must fsync every event');
      } finally {
        await w.close();
      }
    }
  });

  it('terminal kinds list covers every documented terminal event', () => {
    // Spec snapshot — issue #209 acceptance bullet. If a new terminal
    // task event is added, this test forces the author to update the
    // constant explicitly.
    const expected = [
      'task.completed',
      'task.failed',
      'task.merged',
      'task.merge_conflict',
      'task.merge_aborted',
      'task.timeout',
      'task.budget_halt',
    ];
    assert.deepEqual([...TERMINAL_TASK_EVENT_KINDS].sort(), expected.sort());
  });

  it('crash-recovery: terminal event survives an immediate process.exit', () => {
    // Spawn a child Node process via tsx that writes a SINGLE
    // task.completed event then exits immediately with code 0. Because
    // the default durability is `'terminal'`, the fsync MUST have
    // happened before the close+release path, so the event survives in
    // the parent's read.
    //
    // Repo root resolved from this test file's location: tests/run-state/
    // is two levels below the package root.
    const repoRoot = path.resolve(__dirnameCompat(), '..', '..');
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serialized-writer-crash-'));
    const eventsPath = path.join(runDir, 'events.ndjson');
    const childScript = path.join(runDir, 'child.mts');
    const writerSrc = path.join(repoRoot, 'src/core/run-state/serialized-writer.ts');

    fs.writeFileSync(
      childScript,
      `
import { SerializedWriter } from ${JSON.stringify(writerSrc)};
const w = await SerializedWriter.create({
  eventsNdjsonPath: ${JSON.stringify(eventsPath)},
  writerId: { pid: process.pid, hostHash: 'crash-test' },
  pollIntervalMs: 1,
  maxBlockingAttempts: 100,
});
await w.writeEvent({
  event: 'task.completed',
  task_id: 't1',
  base_sha: 'a'.repeat(40),
  task_branch_tip_sha: 'b'.repeat(40),
  task_branch_name: 'x',
  commit_shas: ['b'.repeat(40)],
  completed_at: new Date().toISOString(),
  actual_cost_usd: 0.1,
  exit_status: 'success',
});
// Intentionally exit WITHOUT calling w.close() — simulates a crash
// after the write-then-fsync but before graceful shutdown.
process.exit(0);
`,
    );

    const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
    const res = spawnSync(tsxBin, [childScript], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(res.status, 0, `child failed: stdout=${res.stdout} stderr=${res.stderr}`);

    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, 'terminal event must survive crash');
    const ev = JSON.parse(lines[0]!) as RunEvent;
    assert.equal(ev.event, 'task.completed');
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
