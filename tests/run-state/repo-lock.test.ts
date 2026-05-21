// tests/run-state/repo-lock.test.ts
//
// Unit + multi-process tests for the cross-process repo lock (PR 2/6,
// v7.11.0). Covers issue #189 acceptance bullets:
//
//   * flock acquires exclusive lock on .claude/run-state/repo.lock;
//     second process blocks until first releases
//   * Lock-file content has PID, hostname, command, run_id, acquired_at_iso
//   * Stale-lock detection: PID not running AND >1h triggers user-visible
//     message with --force-unlock recovery command (no auto-clear)
//   * withRepoLock(opts, fn) helper composes flock + truncate-on-release
//   * Multi-process test passes (two real `node` subprocesses)
//   * Exception in wrapped fn still releases the lock (try/finally)
//
// The multi-process test spawns `node --import tsx` subprocesses pointing at
// `_repo-lock-worker.js`. We measure timestamps printed by the subprocesses
// and assert that the second's "acquired" is at or after the first's
// "releasing".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  acquireRepoLock,
  forceUnlockRepoLock,
  formatLockDiagnostic,
  isHolderAlive,
  isLockStale,
  peekRepoLock,
  withRepoLock,
  type RepoLockMetadata,
} from '../../src/core/run-state/repo-lock.ts';
import { GuardrailError } from '../../src/core/errors.ts';

/** Create a unique temp lock path per test. */
function tmpLockPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-lock-'));
  return path.join(dir, 'repo.lock');
}

/** Sleep helper. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Fabricate a metadata blob with overridable fields. */
function makeMeta(overrides: Partial<RepoLockMetadata> = {}): RepoLockMetadata {
  return {
    pid: process.pid,
    hostname: os.hostname(),
    command: 'test',
    run_id: 'test-run',
    acquired_at_iso: new Date().toISOString(),
    ...overrides,
  };
}

describe('repo-lock (single-process)', () => {
  it('acquire + release cleanly', async () => {
    const lockPath = tmpLockPath();
    const { release, metadata } = await acquireRepoLock({
      lockPath,
      command: 'test-cmd',
      run_id: 'test-run',
    });
    assert.equal(metadata.pid, process.pid);
    assert.equal(metadata.hostname, os.hostname());
    assert.equal(metadata.command, 'test-cmd');
    assert.equal(metadata.run_id, 'test-run');
    assert.ok(metadata.acquired_at_iso.length > 0);

    // Metadata sidecar contains the same data.
    const peeked = peekRepoLock(lockPath);
    assert.deepEqual(peeked, metadata);

    await release();

    // After release, metadata is gone.
    assert.equal(peekRepoLock(lockPath), null);
  });

  it('release is idempotent', async () => {
    const lockPath = tmpLockPath();
    const { release } = await acquireRepoLock({
      lockPath,
      command: 'test',
      run_id: 'r',
    });
    await release();
    await release(); // should not throw
    assert.equal(peekRepoLock(lockPath), null);
  });

  it('withRepoLock releases on success', async () => {
    const lockPath = tmpLockPath();
    const value = await withRepoLock(
      { lockPath, command: 'test', run_id: 'r' },
      async () => 'result',
    );
    assert.equal(value, 'result');
    assert.equal(peekRepoLock(lockPath), null);
  });

  it('withRepoLock releases on exception (try/finally)', async () => {
    const lockPath = tmpLockPath();
    await assert.rejects(
      withRepoLock(
        { lockPath, command: 'test', run_id: 'r' },
        async () => {
          throw new Error('inner-boom');
        },
      ),
      /inner-boom/,
    );

    // Lock is released — next acquire should succeed immediately.
    const { release } = await acquireRepoLock({
      lockPath,
      command: 'next',
      run_id: 'r2',
      blocking: false,
    });
    await release();
  });

  it('non-blocking acquire fails fast on contention with metadata', async () => {
    const lockPath = tmpLockPath();
    const first = await acquireRepoLock({
      lockPath,
      command: 'holder',
      run_id: 'holder-run',
    });

    try {
      await acquireRepoLock({
        lockPath,
        command: 'waiter',
        run_id: 'waiter-run',
        blocking: false,
      });
      assert.fail('expected lock_held');
    } catch (err) {
      assert.ok(err instanceof GuardrailError, 'should throw GuardrailError');
      assert.equal((err as GuardrailError).code, 'lock_held');
      const details = (err as GuardrailError).details as Record<string, unknown>;
      const meta = details.metadata as RepoLockMetadata | null;
      assert.ok(meta, 'error details should include holder metadata');
      assert.equal(meta?.command, 'holder');
      assert.equal(meta?.run_id, 'holder-run');
    } finally {
      await first.release();
    }
  });

  it('blocking acquire blocks then succeeds when prior releases', async () => {
    const lockPath = tmpLockPath();
    const first = await acquireRepoLock({
      lockPath,
      command: 'first',
      run_id: 'r1',
    });

    // Start a blocking second acquire; it MUST wait for `first.release()`.
    let secondAcquiredAt = 0;
    const secondPromise = acquireRepoLock({
      lockPath,
      command: 'second',
      run_id: 'r2',
      pollIntervalMs: 10,
    }).then(handle => {
      secondAcquiredAt = Date.now();
      return handle;
    });

    // Hold for 150ms, then release. The second should not acquire before
    // this point.
    await delay(150);
    const releasedAt = Date.now();
    await first.release();

    const second = await secondPromise;
    assert.ok(
      secondAcquiredAt >= releasedAt,
      `second acquired too early: secondAcquiredAt=${secondAcquiredAt} releasedAt=${releasedAt}`,
    );
    await second.release();
  });

  it('blocking acquire respects maxBlockingAttempts', async () => {
    const lockPath = tmpLockPath();
    const first = await acquireRepoLock({
      lockPath,
      command: 'first',
      run_id: 'r1',
    });

    try {
      await assert.rejects(
        acquireRepoLock({
          lockPath,
          command: 'second',
          run_id: 'r2',
          pollIntervalMs: 10,
          maxBlockingAttempts: 3,
        }),
        /timed out/,
      );
    } finally {
      await first.release();
    }
  });
});

describe('repo-lock stale detection', () => {
  it('isHolderAlive returns true for current process', () => {
    assert.ok(isHolderAlive(makeMeta({ pid: process.pid })));
  });

  it('isHolderAlive returns false for impossible PID on this host', () => {
    // PID 0x7FFFFFFF is well above any real PID and effectively impossible.
    // We MUST keep the hostname matching this host, otherwise the function
    // returns true (cross-host = unknown).
    assert.equal(isHolderAlive(makeMeta({ pid: 0x7fffffff })), false);
  });

  it('isHolderAlive returns true for cross-host metadata (cannot probe)', () => {
    assert.ok(isHolderAlive(makeMeta({ hostname: 'definitely-not-this-host-xyz', pid: 1 })));
  });

  it('isLockStale: dead pid + >1h old → stale', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const meta = makeMeta({ pid: 0x7fffffff, acquired_at_iso: twoHoursAgo });
    assert.ok(isLockStale(meta));
  });

  it('isLockStale: dead pid + <1h old → NOT stale', () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const meta = makeMeta({ pid: 0x7fffffff, acquired_at_iso: tenMinAgo });
    assert.equal(isLockStale(meta), false);
  });

  it('isLockStale: live pid + >1h old → NOT stale', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const meta = makeMeta({ pid: process.pid, acquired_at_iso: twoHoursAgo });
    assert.equal(isLockStale(meta), false);
  });

  it('isLockStale: garbage timestamp → NOT stale (recoverable via force-unlock)', () => {
    const meta = makeMeta({ pid: 0x7fffffff, acquired_at_iso: 'not-a-date' });
    assert.equal(isLockStale(meta), false);
  });

  it('acquireRepoLock surfaces stale lock with recovery hint', async () => {
    const lockPath = tmpLockPath();
    // Create the lock dir directly so we can stuff fake "dead and old"
    // metadata into the sidecar without actually holding the lock.
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, '');

    // Manually take the proper-lockfile lock from this process to simulate
    // contention, but write metadata claiming a long-dead PID. The
    // stale-check should fire because PID is impossible AND timestamp is
    // ancient.
    const holder = await acquireRepoLock({
      lockPath,
      command: 'fake-holder',
      run_id: 'fake',
    });
    // Overwrite metadata with stale values WITHOUT releasing the lock.
    const stalePid = 0x7fffffff;
    const ancient = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      lockPath + '.meta.json',
      JSON.stringify(makeMeta({ pid: stalePid, acquired_at_iso: ancient })),
    );

    try {
      await acquireRepoLock({
        lockPath,
        command: 'waiter',
        run_id: 'w',
        blocking: false,
      });
      assert.fail('expected lock_held(stale)');
    } catch (err) {
      assert.ok(err instanceof GuardrailError);
      assert.equal((err as GuardrailError).code, 'lock_held');
      const details = (err as GuardrailError).details as Record<string, unknown>;
      assert.equal(details.stale, true, 'details.stale should be true');
      assert.match(String(details.recovery), /force-unlock/);
    } finally {
      await holder.release();
    }
  });

  it('formatLockDiagnostic includes recovery hint when stale', () => {
    const ancient = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const meta = makeMeta({ pid: 0x7fffffff, acquired_at_iso: ancient });
    const out = formatLockDiagnostic(meta, '/tmp/test.lock');
    assert.match(out, /STALE/);
    assert.match(out, /force-unlock/);
  });

  it('formatLockDiagnostic omits recovery hint when live', () => {
    const meta = makeMeta({ pid: process.pid });
    const out = formatLockDiagnostic(meta, '/tmp/test.lock');
    assert.match(out, /live/);
    assert.doesNotMatch(out, /force-unlock/);
  });
});

describe('repo-lock forceUnlockRepoLock', () => {
  it('removes metadata + lock dir; idempotent', async () => {
    const lockPath = tmpLockPath();
    const { release } = await acquireRepoLock({
      lockPath,
      command: 'c',
      run_id: 'r',
    });
    // Don't release — simulate orphaned state.
    void release; // ensure release isn't GC'd before unlock test

    assert.ok(fs.existsSync(lockPath + '.lock'), 'lock dir should exist');
    assert.ok(fs.existsSync(lockPath + '.meta.json'), 'meta should exist');

    const removed = forceUnlockRepoLock(lockPath);
    assert.equal(removed, true);
    assert.equal(fs.existsSync(lockPath + '.lock'), false);
    assert.equal(fs.existsSync(lockPath + '.meta.json'), false);

    // Idempotent: no-op the second time.
    const removed2 = forceUnlockRepoLock(lockPath);
    assert.equal(removed2, false);

    // Now a fresh acquire works.
    const next = await acquireRepoLock({ lockPath, command: 'next', run_id: 'r2' });
    await next.release();
  });
});

describe('repo-lock cross-process contention', () => {
  /** Locate the JS worker helper next to this test. */
  const workerPath = fileURLToPath(new URL('./_repo-lock-worker.js', import.meta.url));

  /** Spawn the worker subprocess. We re-use the parent's `tsx` import so
   *  the TS source in the worker can resolve. */
  function spawnWorker(lockPath: string, holdMs: number) {
    return spawn(
      process.execPath,
      ['--import', 'tsx', workerPath, lockPath, String(holdMs)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }

  /** Collect stdout + stderr + exit code into a single object. */
  async function collect(
    child: ReturnType<typeof spawnWorker>,
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => err.push(d));
    const code = await new Promise<number | null>(resolve => {
      child.on('close', c => resolve(c));
    });
    return {
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      code,
    };
  }

  /** Parse `acquired:<ts>` / `releasing:<ts>` / `released:<ts>` from
   *  worker output. */
  function parseTimestamps(stdout: string): { acquired: number; releasing: number; released: number } {
    const match = (prefix: string): number => {
      const re = new RegExp(`^${prefix}:(\\d+)$`, 'm');
      const m = stdout.match(re);
      if (!m) throw new Error(`worker output missing ${prefix}: ${stdout}`);
      return parseInt(m[1] as string, 10);
    };
    return {
      acquired: match('acquired'),
      releasing: match('releasing'),
      released: match('released'),
    };
  }

  it('second subprocess blocks until first releases', async () => {
    const lockPath = tmpLockPath();

    // Worker A holds for 400ms.
    const procA = spawnWorker(lockPath, 400);
    // Give A a head start so contention is deterministic — without this,
    // either could grab the lock first and the test logic gets muddled.
    await delay(80);
    // Worker B tries to acquire immediately and holds for 50ms.
    const procB = spawnWorker(lockPath, 50);

    const [resA, resB] = await Promise.all([collect(procA), collect(procB)]);

    assert.equal(resA.code, 0, `A failed: ${resA.stderr || resA.stdout}`);
    assert.equal(resB.code, 0, `B failed: ${resB.stderr || resB.stdout}`);

    const tsA = parseTimestamps(resA.stdout);
    const tsB = parseTimestamps(resB.stdout);

    // Critical assertion: B's acquired timestamp is at or after A's
    // releasing timestamp. We allow a tiny -5ms tolerance because process
    // clock skew within Date.now() granularity is real on macOS.
    assert.ok(
      tsB.acquired + 5 >= tsA.releasing,
      `B acquired before A released: tsA.releasing=${tsA.releasing} tsB.acquired=${tsB.acquired}`,
    );

    // And B observed A holding for the expected duration (>= 350ms held by
    // the wait alone). This catches a regression where the lock falsely
    // resolves immediately.
    assert.ok(
      tsB.acquired - tsA.acquired >= 350,
      `B acquired too soon after A: ${tsB.acquired - tsA.acquired}ms`,
    );

    // Cleanup
    forceUnlockRepoLock(lockPath);
  });
});
