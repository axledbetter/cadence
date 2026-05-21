// tests/run-state/_repo-lock-worker.js
//
// Subprocess helper for the multi-process repo-lock contention test. Spawned
// as `node _repo-lock-worker.js <lockPath> <holdMs>`. Acquires the repo
// lock via withRepoLock, sleeps for `holdMs`, then releases. Prints
// machine-parseable lines on stdout:
//
//   acquired:<ms-since-epoch>
//   releasing:<ms-since-epoch>
//   released:<ms-since-epoch>
//
// And on a known-shape error (lock_held thrown immediately when blocking is
// disabled, NOT expected in the standard test):
//
//   error:<single-line-message>
//
// We use plain JS (not TS) here because `node --import tsx` works for the
// test runner but spawning a tsx-aware subprocess from inside a test is
// fragile across platforms. Instead we import the TS module via tsx's
// `--import` flag, passed by the parent test via argv.

import { withRepoLock } from '../../src/core/run-state/repo-lock.ts';

const lockPath = process.argv[2];
const holdMs = parseInt(process.argv[3] ?? '0', 10);

if (!lockPath) {
  console.error('error:missing lockPath argv');
  process.exit(2);
}

try {
  await withRepoLock(
    {
      lockPath,
      command: 'test-worker',
      run_id: 'test-run',
      // Tests need a faster poll than the 50ms default for snappy CI.
      pollIntervalMs: 20,
      // Cap blocking at 30s — the test asserts contention in <2s, so 30s
      // is a healthy upper bound that won't accidentally hang CI.
      maxBlockingAttempts: 1500,
    },
    async () => {
      console.log(`acquired:${Date.now()}`);
      await new Promise(resolve => setTimeout(resolve, holdMs));
      console.log(`releasing:${Date.now()}`);
    },
  );
  console.log(`released:${Date.now()}`);
  process.exit(0);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`error:${msg.replace(/\n/g, ' ')}`);
  process.exit(1);
}
