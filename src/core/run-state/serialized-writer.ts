// src/core/run-state/serialized-writer.ts
//
// Per-run serialized event writer for `events.ndjson`. PR 3 of 6 of the
// v7.11.0 concurrent subagent execution spec — the "event + budget atomicity"
// layer that the scheduler (PR 4), budget reservation ledger (this PR), and
// merge orchestrator (PR 5) all funnel writes through.
//
// Why a SEPARATE writer when `events.ts` already has `appendEvent`?
//
//   `appendEvent` was designed for the v6 single-writer-per-process model:
//   one phase at a time, no concurrent appenders. Under that model, the
//   per-run lock (`acquireRunLock` in `lock.ts`) is enough — only one
//   process touches events.ndjson at a time.
//
//   v7.11.0 dispatches multiple subagents concurrently. They all stream
//   telemetry to the scheduler, which fans out into per-task budget /
//   completion / failure events. Even within ONE scheduler process, two
//   async tasks landing telemetry simultaneously would race on:
//
//     (replay current state) → (check budget remaining) → (encode event) →
//     (single write() append) → (fsync) → (release lock)
//
//   This file provides an in-process exclusive writer that wraps the
//   critical section in an exclusive file lock (proper-lockfile on a
//   sibling lockfile — NOT on events.ndjson itself, which would block
//   concurrent READERS like `runs show`). The budget-reservation ledger
//   uses this writer to make `reserve()` atomic against concurrent
//   callers.
//
// Lock target choice (subtle, important):
//
//   We lock `<events.ndjson>.writer.lock` (sibling), not `events.ndjson`
//   itself. proper-lockfile's `lock()` creates `<target>.lock` as a
//   directory, but it ALSO stats the target file on every acquire. If we
//   locked events.ndjson directly, two issues arise:
//
//   (1) any reader (`runs show`, `runs replay`) would not block, BUT
//       proper-lockfile inspects the target's mtime to detect staleness.
//       Concurrent appenders flipping mtime would confuse the staleness
//       heuristic. We disable it (`stale: 0`) but the safer separation is
//       lock target ≠ data file.
//   (2) the lockfile directory `<events.ndjson>.lock` would sit next to
//       the data file, which is what the file watchers in `runs tail`
//       (PR 6) expect to be a clean ndjson stream.
//
//   So: data file = `events.ndjson`. Lock target = `events.ndjson.writer.lock`
//   (placeholder file). Lock directory created by proper-lockfile =
//   `events.ndjson.writer.lock.lock` (we don't see this directly).
//
// Write atomicity:
//
//   We MUST ensure a single appender write produces either a full line +
//   '\n' or nothing — never half a line. Node's `fs.appendFile` is
//   documented to use a SINGLE writev/write syscall on POSIX for buffers
//   up to PIPE_BUF (4KB on Linux/macOS). Our events are typically well
//   under 4KB (the largest, `task.completed`, is ~600 bytes with 10
//   commit SHAs). To be safe we:
//
//   (1) encode the event to a Buffer once
//   (2) call `fs.writeSync(fd, buf)` (single syscall, no streaming JSON)
//   (3) `fs.fsyncSync(fd)`
//
//   And we hold the exclusive lock across (1)+(2)+(3) so no other appender
//   in the same process can interleave bytes. The OS-level append guarantee
//   from `O_APPEND` is a backstop for cross-process scenarios (which the
//   spec doesn't require — single scheduler process owns the writer — but
//   costs nothing to keep).
//
// Spec:
//   docs/superpowers/specs/2026-05-19-v7.11.0-concurrent-subagent-execution-design.md
//   section "Budget reservation semantics (with atomic event writes)".

import * as fs from 'node:fs';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';

import { GuardrailError } from '../errors.ts';
import { updateLockSeq } from './lock.ts';
import { readMaxSeq } from './events.ts';
import {
  RUN_STATE_SCHEMA_VERSION,
  type RunEvent,
  type RunEventInput,
  type WriterId,
} from './types.ts';

/** Sibling path suffix for the writer's exclusive lock. */
const WRITER_LOCK_SUFFIX = '.writer.lock';

/** Default poll interval / max attempts when the lock is contended. The
 *  serialized writer is in-process most of the time, so contention is
 *  measured in microseconds; the 20-min ceiling exists only to prevent a
 *  bug from hanging tests indefinitely. */
const DEFAULT_POLL_MS = 5;
const DEFAULT_MAX_ATTEMPTS = 240_000; // 240_000 * 5ms = 20 minutes

export interface SerializedWriterOptions {
  /** Absolute path to `events.ndjson` for the run. */
  eventsNdjsonPath: string;
  /** Override the lock-target path. Default: `<eventsNdjsonPath>.writer.lock`. */
  lockPath?: string;
  /** Writer identity stamped onto every event. */
  writerId: WriterId;
  /** Override the runId stamped onto events. Default: basename of the
   *  events file's parent dir (the run-ulid). */
  runId?: string;
  /** Poll interval (ms) when the writer lock is contended. Default 5ms. */
  pollIntervalMs?: number;
  /** Max retry attempts when blocking on lock. Default 240_000. */
  maxBlockingAttempts?: number;
}

/**
 * Per-run serialized event writer.
 *
 * Usage:
 * ```ts
 * const writer = await SerializedWriter.create({
 *   eventsNdjsonPath: path.join(runDir, 'events.ndjson'),
 *   writerId: { pid: process.pid, hostHash: '...' },
 * });
 * try {
 *   await writer.writeEvent({ event: 'task.started', task_id: 't1', ... });
 * } finally {
 *   await writer.close();
 * }
 * ```
 *
 * Single-instance contract: only ONE SerializedWriter per run should exist at
 * any time. The per-run lock (`acquireRunLock`) enforces this across
 * processes; this writer adds the in-process critical-section serialization
 * that budget reservation + concurrent subagent telemetry require.
 */
export class SerializedWriter {
  private fd: number | null = null;
  private closed = false;
  private readonly opts: Required<Omit<SerializedWriterOptions, 'runId'>> & {
    runId?: string;
  };

  private constructor(opts: SerializedWriterOptions) {
    this.opts = {
      eventsNdjsonPath: opts.eventsNdjsonPath,
      lockPath: opts.lockPath ?? opts.eventsNdjsonPath + WRITER_LOCK_SUFFIX,
      writerId: opts.writerId,
      runId: opts.runId,
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_MS,
      maxBlockingAttempts: opts.maxBlockingAttempts ?? DEFAULT_MAX_ATTEMPTS,
    };
  }

  /** Construct a writer and prime the file descriptor. The events file and
   *  lock target are created if missing. */
  static async create(opts: SerializedWriterOptions): Promise<SerializedWriter> {
    const w = new SerializedWriter(opts);
    await w.init();
    return w;
  }

  private async init(): Promise<void> {
    // Ensure run dir exists.
    fs.mkdirSync(path.dirname(this.opts.eventsNdjsonPath), { recursive: true });

    // Ensure events file exists (open for append creates it but
    // proper-lockfile's stat-then-lock needs the lock target to exist too).
    if (!fs.existsSync(this.opts.eventsNdjsonPath)) {
      fs.writeFileSync(this.opts.eventsNdjsonPath, '');
    }
    if (!fs.existsSync(this.opts.lockPath)) {
      fs.writeFileSync(this.opts.lockPath, '');
    }

    // Open the events file in O_APPEND mode. POSIX guarantees each write()
    // is atomic at the kernel boundary regardless of competing writers.
    this.fd = fs.openSync(this.opts.eventsNdjsonPath, 'a');
  }

  /**
   * Append a single event under the exclusive writer lock. The critical
   * section spans: encode event → write() → fsync(). The runner's caller
   * supplies the partial event (no `seq`, `ts`, `runId`, `schema_version`,
   * `writerId` — we fill those in atomically based on the on-disk state at
   * lock-acquisition time).
   *
   * Returns the fully-formed `RunEvent` that landed on disk. Throws
   * `GuardrailError` on lock acquisition / I/O failure.
   */
  async writeEvent<T extends RunEvent = RunEvent>(input: RunEventInput): Promise<T> {
    if (this.closed) {
      throw new GuardrailError('SerializedWriter: writeEvent after close', {
        code: 'adapter_bug',
        provider: 'run-state',
        details: { eventsNdjsonPath: this.opts.eventsNdjsonPath },
      });
    }
    return this.withLock(() => this.appendUnderLock<T>(input));
  }

  /**
   * Run an arbitrary function under the exclusive writer lock. Used by
   * `BudgetReservation.reserve()` and friends to compose
   * (replay-from-disk → check → append-event) into one atomic critical
   * section. The function receives a `writeEvent` that bypasses the
   * already-held lock.
   */
  async withExclusive<T>(
    fn: (api: {
      writeEvent: <E extends RunEvent = RunEvent>(input: RunEventInput) => Promise<E>;
      readMaxSeq: () => number;
      eventsNdjsonPath: string;
    }) => Promise<T>,
  ): Promise<T> {
    if (this.closed) {
      throw new GuardrailError('SerializedWriter: withExclusive after close', {
        code: 'adapter_bug',
        provider: 'run-state',
        details: { eventsNdjsonPath: this.opts.eventsNdjsonPath },
      });
    }
    const runDir = path.dirname(this.opts.eventsNdjsonPath);
    return this.withLock(() =>
      fn({
        writeEvent: async <E extends RunEvent = RunEvent>(input: RunEventInput) =>
          this.appendUnderLock<E>(input),
        readMaxSeq: () => readMaxSeq(runDir),
        eventsNdjsonPath: this.opts.eventsNdjsonPath,
      }),
    );
  }

  /**
   * Append-and-write under an already-held lock. INTERNAL — must only be
   * called from `withLock`'s closure.
   */
  private async appendUnderLock<T extends RunEvent>(
    input: RunEventInput,
  ): Promise<T> {
    if (this.fd === null) {
      throw new GuardrailError('SerializedWriter: fd not initialised', {
        code: 'adapter_bug',
        provider: 'run-state',
      });
    }

    const runDir = path.dirname(this.opts.eventsNdjsonPath);
    const runId = this.opts.runId ?? path.basename(runDir);
    const prevSeq = readMaxSeq(runDir);
    const seq = prevSeq + 1;

    const fullEvent = {
      schema_version: RUN_STATE_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      runId,
      seq,
      writerId: this.opts.writerId,
      ...input,
    } as unknown as T;

    // Encode to Buffer in a single allocation, then write in a single
    // syscall. POSIX guarantees write() of a buffer <= PIPE_BUF (4KB) is
    // atomic at the kernel boundary. Our events fit well under that.
    const buf = Buffer.from(JSON.stringify(fullEvent) + '\n', 'utf8');
    fs.writeSync(this.fd, buf, 0, buf.length);
    fs.fsyncSync(this.fd);

    // Best-effort seq sidecar + lock-seq advance. These mirror what
    // `appendEvent` in events.ts does so the rest of the run-state engine
    // sees a consistent view.
    try {
      fs.writeFileSync(path.join(runDir, '.seq'), String(seq), 'utf8');
    } catch {
      // intentionally swallowed — the events file is authoritative
    }
    try {
      updateLockSeq(runDir, seq);
    } catch {
      // intentionally swallowed — per-run lock may not exist in tests
    }

    return fullEvent;
  }

  /**
   * Acquire the exclusive writer lock, run `fn`, then release. Uses a
   * spin-poll because proper-lockfile's internal retry has exponential
   * backoff which composes poorly with the high-frequency contention
   * pattern of a concurrent dispatcher.
   *
   * Exception inside `fn` still triggers `release()` via try/finally.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: (() => Promise<void>) | null = null;
    let attempts = 0;
    for (;;) {
      try {
        release = await lockfile.lock(this.opts.lockPath, {
          retries: 0,
          // Disable proper-lockfile's mtime-based staleness — the writer is
          // single-instance per scheduler process; if it crashes, the lock
          // dir is cleaned by next-process startup, NOT by mtime heuristic.
          stale: 0,
          realpath: false,
        });
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ELOCKED') {
          throw new GuardrailError(
            `SerializedWriter: lock acquire failed: ${(err as Error).message}`,
            {
              code: 'lock_held',
              provider: 'run-state',
              details: { lockPath: this.opts.lockPath },
            },
          );
        }
        attempts += 1;
        if (attempts > this.opts.maxBlockingAttempts) {
          throw new GuardrailError(
            `SerializedWriter: lock acquire timed out after ${attempts} attempts`,
            {
              code: 'lock_held',
              provider: 'run-state',
              details: {
                lockPath: this.opts.lockPath,
                attempts,
                pollMs: this.opts.pollIntervalMs,
              },
            },
          );
        }
        await new Promise<void>(r => setTimeout(r, this.opts.pollIntervalMs));
      }
    }
    try {
      return await fn();
    } finally {
      // Release MUST run even if `fn` threw. proper-lockfile's release can
      // throw if the dir was removed out from under us; swallow because
      // either way our lock is gone.
      if (release) {
        try {
          await release();
        } catch {
          // intentionally swallowed
        }
      }
    }
  }

  /** Close the writer's file descriptor. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // intentionally swallowed
      }
      this.fd = null;
    }
  }
}

/** Convenience: lock-target path for a given events.ndjson path. Exposed so
 *  tests + the budget-reservation module can reference the same convention. */
export function writerLockPathFor(eventsNdjsonPath: string): string {
  return eventsNdjsonPath + WRITER_LOCK_SUFFIX;
}
