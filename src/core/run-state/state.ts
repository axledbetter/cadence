// src/core/run-state/state.ts
//
// Atomic snapshot writer for state.json. Persistence protocol per spec:
//   1. write to state.json.tmp
//   2. fsync(file) on the tmp
//   3. rename tmp → state.json
//   4. fsync(dir) so the rename is durable
//
// readStateSnapshot() returns null if the snapshot is missing (the canonical
// "fresh run" state) and throws if it's present-but-corrupt. recoverState()
// is the resilience entry point — it falls back to events.ndjson replay if
// the snapshot is unreadable, then rewrites a clean snapshot and emits an
// `index.rebuilt` event.
//
// Spec: docs/specs/v6-run-state-engine.md "Persistence protocol — Durable
// append", "Failure modes the user should never have to debug".

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GuardrailError } from '../errors.ts';
import { PROTOCOL_VERSION } from '../protocol/version.ts';
import { appendEvent, replayState } from './events.ts';
import { RUN_STATE_SCHEMA_VERSION, type RunState, type WriterId } from './types.ts';

// ---------------------------------------------------------------------------
// v6.2.2 — cache contract version policy (per spec / codex WARNING #1).
//
// `replayState()` uses these bounds to reject run dirs whose `schema_version`
// is outside the supported window. Strict equality would block resume across
// rolling deploys / mixed binary fleets — the window allows additive minor
// schema bumps to ship without breaking forward-read on older readers, and a
// future major (v7) resets `MIN_SUPPORTED` to break with the past explicitly.
// ---------------------------------------------------------------------------

/** Lowest `schema_version` value this binary can replay. Bump only on a
 *  major release that drops support for a prior wire shape. */
export const RUN_STATE_MIN_SUPPORTED_SCHEMA_VERSION = 1 as const;

/** Highest `schema_version` value this binary can replay. Always equal to
 *  the writer's `RUN_STATE_SCHEMA_VERSION` — the writer never produces a
 *  newer shape than the reader on the same binary. */
export const RUN_STATE_MAX_SUPPORTED_SCHEMA_VERSION = RUN_STATE_SCHEMA_VERSION;

const STATE_FILE = 'state.json';
const STATE_TMP = 'state.json.tmp';

export function statePath(runDir: string): string {
  return path.join(runDir, STATE_FILE);
}

function tmpPath(runDir: string): string {
  return path.join(runDir, STATE_TMP);
}

/** Write the snapshot atomically. Sequence:
 *    open(tmp, 'w') → write → fsync(fd) → close → rename → fsync(dirfd).
 *
 *  If any step fails, the tmp file is best-effort-cleaned. The pre-existing
 *  state.json is untouched until the rename, so a crash anywhere before
 *  rename leaves the previous snapshot intact. */
export function writeStateSnapshot(runDir: string, state: RunState): void {
  fs.mkdirSync(runDir, { recursive: true });
  // Stamp the cadence protocol_version on every snapshot we write (v8.6.0+).
  // The field is additive and lives alongside the internal `schema_version`
  // (separate concern — engine wire format). Old binaries reading newer
  // snapshots ignore unknown top-level fields, so rollback is clean.
  // Spec: docs/superpowers/specs/2026-05-27-protocol-versioning-design.md.
  const stateWithProtocol: RunState = {
    ...state,
    protocol_version: state.protocol_version ?? PROTOCOL_VERSION,
  };
  const data = JSON.stringify(stateWithProtocol, null, 2);
  const tmp = tmpPath(runDir);
  const target = statePath(runDir);

  const fd = fs.openSync(tmp, 'w');
  let wroteOk = false;
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    wroteOk = true;
  } finally {
    fs.closeSync(fd);
    if (!wroteOk) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  fs.renameSync(tmp, target);

  // fsync the parent directory so the rename is durable on power-loss.
  // On Linux/macOS this is best-effort (ENOTSUP on some filesystems for
  // dir fds); we swallow expected platform-specific failures so a
  // working-directory on tmpfs / SMB / etc. doesn't break the writer.
  try {
    const dirFd = fs.openSync(runDir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EISDIR happens on some Windows configs where opening a dir for read
    // isn't permitted; EPERM/ENOTSUP on certain FS. We don't escalate —
    // the rename itself is atomic; dir-fsync is a defense-in-depth.
    if (code !== 'EISDIR' && code !== 'EPERM' && code !== 'ENOTSUP') {
      // Anything else, surface as warning via a thrown GuardrailError so
      // callers can decide. We choose `corrupted_state` as the closest
      // category since the snapshot may not have been durably committed.
      throw new GuardrailError(
        `state.json: dir fsync failed: ${(err as Error).message}`,
        {
          code: 'corrupted_state',
          provider: 'run-state',
          details: { runDir, errno: code },
        },
      );
    }
  }
}

/** Read the snapshot. Returns null if missing. Throws GuardrailError(
 *  corrupted_state) if it's present but unparseable — recoverState() handles
 *  the fallback to events-replay. */
export function readStateSnapshot(runDir: string): RunState | null {
  const p = statePath(runDir);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw) {
    throw new GuardrailError(`state.json: empty file`, {
      code: 'corrupted_state',
      provider: 'run-state',
      details: { runDir },
    });
  }
  try {
    return JSON.parse(raw) as RunState;
  } catch (err) {
    throw new GuardrailError(
      `state.json: corrupt JSON: ${(err as Error).message}`,
      {
        code: 'corrupted_state',
        provider: 'run-state',
        details: { runDir, error: (err as Error).message },
      },
    );
  }
}

export interface RecoverStateOptions {
  /** Writer that will own the recovery's `index.rebuilt` event. The
   *  caller must already hold the run's advisory lock. */
  writerId: WriterId;
  /** runId override; defaults to basename(runDir). */
  runId?: string;
}

export interface RecoverStateResult {
  state: RunState;
  /** True if recovery actually re-derived the snapshot (vs. just reading
   *  a healthy one). */
  recovered: boolean;
  /** When `recovered === true`, the cause that triggered the rebuild. */
  cause?: 'missing' | 'corrupt';
}

/** Open-or-recover the snapshot. If state.json is missing or corrupt, fall
 *  back to events.ndjson replay, persist the result, and emit
 *  `index.rebuilt`. The caller MUST already hold the advisory lock. */
export function recoverState(
  runDir: string,
  opts: RecoverStateOptions,
): RecoverStateResult {
  let cause: 'missing' | 'corrupt' | null = null;
  let snapshot: RunState | null = null;
  try {
    snapshot = readStateSnapshot(runDir);
    if (!snapshot) cause = 'missing';
  } catch (err) {
    if (err instanceof GuardrailError && err.code === 'corrupted_state') {
      cause = 'corrupt';
    } else {
      throw err;
    }
  }
  if (!cause && snapshot) {
    return { state: snapshot, recovered: false };
  }

  // Recovery path. Replay first, then persist, then emit event in that
  // order — emitting the event before persisting would leave a record of
  // a recovery that didn't actually land if we crash between the two.
  const replayed = replayState(runDir);
  writeStateSnapshot(runDir, replayed);
  appendEvent(
    runDir,
    { event: 'index.rebuilt', cause: cause as 'missing' | 'corrupt' },
    { writerId: opts.writerId, ...(opts.runId !== undefined ? { runId: opts.runId } : {}) },
  );

  return {
    state: replayed,
    recovered: true,
    cause: cause as 'missing' | 'corrupt',
  };
}
