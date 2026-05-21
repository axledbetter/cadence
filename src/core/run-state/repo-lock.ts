// src/core/run-state/repo-lock.ts
//
// Cross-process advisory lock for repo-mutating CLI operations. PR 2 of 6 of
// the v7.11.0 concurrent subagent execution spec — the "Layer 2" half of
// the two-layer critical-section serialization (Layer 1 is the in-process
// mutex in `src/core/concurrent-dispatch/git-op-queue.ts`).
//
// Why a SEPARATE file from `lock.ts`?
//
//   `lock.ts` is the PER-RUN lock — one lock per `<run-ulid>` directory, used
//   by the run-state engine to enforce single-writer on `events.ndjson` and
//   `state.json`. Different concurrent runs are intentionally allowed; the
//   per-run lock just prevents two writers from corrupting one run's log.
//
//   This file is the PER-REPO lock — one lock per worktree, used by the
//   merge orchestrator to serialize cross-process git mutations on
//   `.git/index`, refs, and packed-refs. Two concurrent runs in the same
//   repo MUST serialize their merges; this lock is the cross-process gate.
//
// We could not reuse `acquireRunLock` because:
//   - it takes a `runDir`, but repo-lock guards a path outside any run dir
//   - it throws `GuardrailError(lock_held)` immediately on contention,
//     whereas the spec requires `withRepoLock` to BLOCK until the prior
//     holder releases (multi-process test asserts this)
//   - it has no "stale-lock surfacing" path with a `--force-unlock`
//     recovery hint; it has `forceTakeover` instead, which is a different
//     contract
//
// Library choice: `proper-lockfile` (already a dep) over raw `flock`/`fcntl`
// for portability — it implements an mkdir-based atomic lock that works on
// POSIX and Windows. The spec mentions flock as one option; the spec also
// says "fcntl for portability; pick one consistently". `proper-lockfile`'s
// approach is functionally equivalent for our purpose (kernel-atomic
// rendezvous between processes), so we use it for consistency with the
// existing per-run lock.
//
// Spec: docs/superpowers/specs/2026-05-19-v7.11.0-concurrent-subagent-execution-design.md
// section "Git critical-section serialization (two-layer)".

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { GuardrailError } from '../errors.ts';

/** Sidecar metadata file name — sits next to the lock target. We keep it
 *  outside the lock dir that proper-lockfile manages so an interrupted
 *  release leaves either (a) both files (release will be retried) or
 *  (b) just the meta orphan (the next acquire ignores it once flock
 *  succeeds). */
const META_SUFFIX = '.meta.json';

/** Stale-lock threshold. Spec: "PID not running on hostname AND timestamp
 *  is > 1h old". We hard-code 1 hour; tests inject a clock via the
 *  acquired_at_iso they write. */
const STALE_THRESHOLD_MS = 60 * 60 * 1000;

/** Default poll interval and max attempts when blocking on contention.
 *  proper-lockfile's `retries` is wall-clock total + exponential — we want
 *  a simpler "poll every N ms forever (until externally aborted)" model so
 *  the multi-process test's blocked waiter is deterministic. */
const DEFAULT_POLL_MS = 50;
const DEFAULT_BLOCKING_MAX_ATTEMPTS = 24_000; // 24_000 * 50ms = 20 minutes

/**
 * Metadata persisted to the lock's sidecar JSON. Read by `cleanup
 * --force-unlock` to display "what was the holder when this lock went
 * stale" and by the stale-lock detector to decide whether to surface a
 * recovery hint.
 */
export interface RepoLockMetadata {
  /** Process ID of the holder at acquisition time. */
  pid: number;
  /** `os.hostname()` of the holder. Plain (not hashed) — this lock is
   *  per-worktree and worktrees do not move between hosts; debuggability
   *  trumps the very-mild PII concern. */
  hostname: string;
  /** Free-form label identifying the CLI command that took the lock.
   *  Conventionally `<verb> <sub-verb>`, e.g. `"runs cleanup"`. */
  command: string;
  /** Run-state ULID associated with the operation, if any. May be
   *  `"unknown"` for non-run-scoped commands like `runs gc`. */
  run_id: string;
  /** ISO 8601 timestamp of acquisition. Used by stale-lock detection. */
  acquired_at_iso: string;
}

export interface AcquireRepoLockOptions {
  /** Absolute path to the lock file. Conventionally
   *  `<repo>/.claude/run-state/repo.lock`. Parent dirs are created on demand. */
  lockPath: string;
  /** Label for the metadata. Conventionally `<verb> <sub-verb>`. */
  command: string;
  /** Run-state ULID, or `"unknown"` for commands outside a run. */
  run_id: string;
  /** If true (default), block until the lock is available. If false, throw
   *  immediately on contention with a `lock_held` GuardrailError carrying
   *  the existing metadata. */
  blocking?: boolean;
  /** Poll interval when blocking. Tests use a smaller value. Default 50ms. */
  pollIntervalMs?: number;
  /** Max retry attempts when blocking. Tests use a smaller value so an
   *  accidentally-leaked lock doesn't hang the suite for 20 minutes. */
  maxBlockingAttempts?: number;
}

export interface AcquireRepoLockResult {
  /** Release the lock — unlink metadata + release the proper-lockfile dir.
   *  Idempotent: calling twice is a no-op the second time. */
  release: () => Promise<void>;
  /** The metadata we wrote on acquisition. Returned for logging. */
  metadata: RepoLockMetadata;
}

function metaPathFor(lockPath: string): string {
  return lockPath + META_SUFFIX;
}

function ensureParentDir(lockPath: string): void {
  const parent = path.dirname(lockPath);
  fs.mkdirSync(parent, { recursive: true });
}

function ensureLockTargetFile(lockPath: string): void {
  // proper-lockfile.lock requires the target file to exist (it locks the dir
  // it creates as `<file>.lock`, but the lookup still stats the target).
  // Creating an empty placeholder is fine — the kernel atomicity is in the
  // sibling dir, not in the file itself.
  if (!fs.existsSync(lockPath)) {
    fs.writeFileSync(lockPath, '');
  }
}

function readMetadata(lockPath: string): RepoLockMetadata | null {
  const p = metaPathFor(lockPath);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as RepoLockMetadata;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.hostname === 'string' &&
      typeof parsed.command === 'string' &&
      typeof parsed.run_id === 'string' &&
      typeof parsed.acquired_at_iso === 'string'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeMetadata(lockPath: string, meta: RepoLockMetadata): void {
  const p = metaPathFor(lockPath);
  fs.writeFileSync(p, JSON.stringify(meta, null, 2), 'utf8');
}

function deleteMetadata(lockPath: string): void {
  const p = metaPathFor(lockPath);
  try {
    fs.unlinkSync(p);
  } catch {
    // idempotent — meta may already be gone
  }
}

/**
 * Probe whether a PID is alive on the local host. Uses the POSIX
 * `kill(pid, 0)` trick which checks existence without delivering a signal.
 *
 * IMPORTANT: This returns `true` for any non-local hostname — we cannot
 * probe a process on another machine, and a network-mounted lock dir could
 * be valid. Better to leave the lock alone than to steal one held by a
 * sibling host (which would corrupt the other host's repo state).
 */
export function isHolderAlive(meta: RepoLockMetadata): boolean {
  if (meta.hostname !== os.hostname()) {
    // Different host. We can't probe. Treat as alive (safer default —
    // matches the per-run lock's `isPidAlive` contract).
    return true;
  }
  if (meta.pid <= 0) return false;
  if (meta.pid === process.pid) return true;
  try {
    process.kill(meta.pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH = no such process. EPERM = process exists but signal denied.
    // Anything else: default to alive.
    if (code === 'ESRCH') return false;
    return true;
  }
}

/**
 * Decide whether the holding metadata represents a stale lock per the spec:
 * "PID not running on hostname AND `acquired_at_iso` > 1 hour old".
 *
 * Both conditions are required. A process that is still running but has
 * held the lock for >1h is NOT stale — it could be a long merge, and
 * stealing the lock would corrupt git state.
 */
export function isLockStale(meta: RepoLockMetadata, now: number = Date.now()): boolean {
  if (isHolderAlive(meta)) return false;
  const acquiredAt = Date.parse(meta.acquired_at_iso);
  if (!Number.isFinite(acquiredAt)) {
    // Garbage timestamp. We choose to treat unparseable as "fresh" (not
    // stale) — a broken metadata file should still surface to the user
    // via `cleanup --force-unlock` rather than be silently stolen.
    return false;
  }
  return now - acquiredAt > STALE_THRESHOLD_MS;
}

/**
 * Format a user-facing diagnostic for a contended lock. Used both in the
 * `lock_held` thrown error and by the CLI when printing what `cleanup
 * --force-unlock` is about to delete.
 */
export function formatLockDiagnostic(meta: RepoLockMetadata, lockPath: string): string {
  const stale = isLockStale(meta);
  const lines = [
    `Repo lock at ${lockPath} is held by:`,
    `  pid:             ${meta.pid}`,
    `  hostname:        ${meta.hostname}`,
    `  command:         ${meta.command}`,
    `  run_id:          ${meta.run_id}`,
    `  acquired_at_iso: ${meta.acquired_at_iso}`,
    stale
      ? `  STATUS:          STALE (PID not running and >1h old)`
      : `  STATUS:          live (holder appears active)`,
  ];
  if (stale) {
    lines.push('');
    lines.push(
      'Recovery: claude-autopilot runs cleanup --force-unlock',
    );
  }
  return lines.join('\n');
}

/**
 * Acquire the cross-process repo lock. Blocks until the previous holder
 * releases (default) or throws immediately on contention (`blocking:
 * false`).
 *
 * On success, writes a metadata sidecar with PID/hostname/command/run_id/
 * timestamp and returns a `release()` callback.
 *
 * Stale-lock handling: if the existing metadata shows the holder is dead
 * and the lock is >1h old, this function still THROWS rather than
 * auto-clearing — the user must invoke `runs cleanup --force-unlock` to
 * confirm. The thrown error includes the stale-lock diagnostic and
 * recovery hint.
 */
export async function acquireRepoLock(
  opts: AcquireRepoLockOptions,
): Promise<AcquireRepoLockResult> {
  const blocking = opts.blocking !== false; // default true
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const maxAttempts = opts.maxBlockingAttempts ?? DEFAULT_BLOCKING_MAX_ATTEMPTS;
  const { lockPath } = opts;

  ensureParentDir(lockPath);
  ensureLockTargetFile(lockPath);

  let releaseLockfile: (() => Promise<void>) | null = null;
  let attempts = 0;

  // Try to acquire. proper-lockfile.lock throws ELOCKED on contention.
  for (;;) {
    try {
      releaseLockfile = await lockfile.lock(lockPath, {
        // We do our own polling, so disable proper-lockfile's internal retry
        // (it has its own exponential backoff which would compose oddly with
        // our loop).
        retries: 0,
        // Disable proper-lockfile's stale-mtime takeover. The spec requires
        // user confirmation for stale takeover (`cleanup --force-unlock`)
        // and proper-lockfile's auto-takeover at 10s would conflict with
        // that. We do staleness via metadata + PID probe ourselves.
        stale: 0,
        // Don't resolve symlinks — lockPath is given absolute by the caller
        // and we want lock identity to match the literal path (the CLI
        // displays it back to the user).
        realpath: false,
      });
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const isContention = code === 'ELOCKED';
      if (!isContention) {
        throw new GuardrailError(
          `repo lock acquire failed: ${(err as Error).message}`,
          {
            code: 'lock_held',
            provider: 'repo-lock',
            details: { lockPath, cause: (err as Error).message },
          },
        );
      }

      // Read existing metadata for the diagnostic / stale-check.
      const existing = readMetadata(lockPath);

      if (existing && isLockStale(existing)) {
        // Stale per spec: do NOT auto-clear. Surface with recovery hint.
        throw new GuardrailError(
          'repo lock is STALE (holder dead and >1h old) — re-run with `runs cleanup --force-unlock` to clear',
          {
            code: 'lock_held',
            provider: 'repo-lock',
            details: {
              lockPath,
              stale: true,
              metadata: existing,
              recovery: 'claude-autopilot runs cleanup --force-unlock',
            },
          },
        );
      }

      if (!blocking) {
        throw new GuardrailError(
          existing
            ? `repo lock held by pid=${existing.pid} command="${existing.command}" since ${existing.acquired_at_iso}`
            : 'repo lock held by another process',
          {
            code: 'lock_held',
            provider: 'repo-lock',
            details: {
              lockPath,
              stale: false,
              metadata: existing,
            },
          },
        );
      }

      attempts += 1;
      if (attempts > maxAttempts) {
        throw new GuardrailError(
          `repo lock acquire timed out after ${attempts} attempts (${attempts * pollMs}ms)`,
          {
            code: 'lock_held',
            provider: 'repo-lock',
            details: {
              lockPath,
              metadata: existing,
              attempts,
            },
          },
        );
      }

      // Wait and retry. We use setTimeout (not setInterval) so each attempt
      // measures from the end of the previous attempt — the queue is FIFO
      // by polling order, not by arrival time.
      await new Promise<void>(resolve => setTimeout(resolve, pollMs));
    }
  }

  // We hold the lock. Write metadata AFTER acquisition so a partial-create
  // (crash here) leaves the lock with no metadata, which is recoverable
  // (the next acquire will see "lock_held" with no diagnostic; the user
  // can `cleanup --force-unlock` once the dead PID times out).
  const metadata: RepoLockMetadata = {
    pid: process.pid,
    hostname: os.hostname(),
    command: opts.command,
    run_id: opts.run_id,
    acquired_at_iso: new Date().toISOString(),
  };
  writeMetadata(lockPath, metadata);

  let released = false;
  return {
    metadata,
    release: async () => {
      if (released) return;
      released = true;
      // Order matters: delete metadata BEFORE releasing the lockfile dir.
      // If we crash between the two, the lockfile dir is still there and
      // the next acquire will see "lock_held" with no metadata. That's
      // recoverable (user can wait 1h for staleness or force-unlock).
      // The reverse order would leave the metadata orphaned, which is
      // confusing because a new holder would overwrite it on acquire.
      deleteMetadata(lockPath);
      if (releaseLockfile) {
        try {
          await releaseLockfile();
        } catch {
          // proper-lockfile's release can throw if the dir was removed
          // out from under us (e.g. by `cleanup --force-unlock`). Either
          // way, our lock is gone — swallow.
        }
      }
    },
  };
}

/**
 * Compose acquire + run-fn + release. The fn ALWAYS runs inside try/finally
 * so a thrown exception still releases the lock. Returns the fn's resolved
 * value.
 */
export async function withRepoLock<T>(
  opts: AcquireRepoLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const { release } = await acquireRepoLock(opts);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Read the current holder's metadata without taking the lock. Returns null
 * if no metadata sidecar exists. Used by `runs cleanup --force-unlock` to
 * show the user what's about to be deleted.
 */
export function peekRepoLock(lockPath: string): RepoLockMetadata | null {
  return readMetadata(lockPath);
}

/**
 * Forcibly clear a repo lock. Deletes the metadata sidecar AND the
 * proper-lockfile-managed `.lock` directory. The caller MUST have already
 * confirmed with the user that this is safe (the holder is truly dead) —
 * this function does no probing of its own.
 *
 * Returns `true` if anything was removed, `false` if there was nothing to
 * clean.
 */
export function forceUnlockRepoLock(lockPath: string): boolean {
  let removed = false;

  if (fs.existsSync(metaPathFor(lockPath))) {
    deleteMetadata(lockPath);
    removed = true;
  }

  // proper-lockfile creates `<lockPath>.lock` as a directory.
  const lockDir = lockPath + '.lock';
  if (fs.existsSync(lockDir)) {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
      removed = true;
    } catch {
      // best-effort
    }
  }

  return removed;
}
