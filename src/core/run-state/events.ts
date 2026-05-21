// src/core/run-state/events.ts
//
// Append-only event log + state replay. Implements the persistence protocol
// from the v6 spec — open(O_APPEND) + write + fsync(fd) for every event;
// monotonic seq assigned by the holding writer; partial-write detection on
// read with auto-emission of `run.recovery` on the next append.
//
// Spec: docs/specs/v6-run-state-engine.md "Persistence protocol", "Run
// lifecycle", "Failure modes".

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GuardrailError } from '../errors.ts';
import { updateLockSeq } from './lock.ts';
import {
  RUN_STATE_SCHEMA_VERSION,
  type ExternalRef,
  type PhaseSnapshot,
  type RunEvent,
  type RunEventInput,
  type RunIndexEntry,
  type RunState,
  type WriterId,
} from './types.ts';

const EVENTS_FILE = 'events.ndjson';
/** Optional sidecar that records the highest seq we've successfully written.
 *  Lets us assign the next seq in O(1) instead of rescanning the tail of the
 *  log. The log itself is still authoritative — if the sidecar disagrees, we
 *  trust the log. */
const SEQ_SIDECAR = '.seq';
/** Marker that lives next to events.ndjson when the last read detected a
 *  truncated tail. The next `appendEvent` consumes the marker, emits a
 *  recovery event, and clears it. */
const PARTIAL_WRITE_MARKER = '.partial-write';

export function eventsPath(runDir: string): string {
  return path.join(runDir, EVENTS_FILE);
}

function seqSidecarPath(runDir: string): string {
  return path.join(runDir, SEQ_SIDECAR);
}

function partialMarkerPath(runDir: string): string {
  return path.join(runDir, PARTIAL_WRITE_MARKER);
}

function readSeqSidecar(runDir: string): number | null {
  const p = seqSidecarPath(runDir);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8').trim();
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function writeSeqSidecar(runDir: string, seq: number): void {
  // Best-effort. If this fails we'll just rescan the log on next open.
  try {
    fs.writeFileSync(seqSidecarPath(runDir), String(seq), 'utf8');
  } catch {
    // intentionally swallowed
  }
}

export interface ReadEventsOptions {
  /** Skip events with seq < this value. */
  fromSeq?: number;
  /** Return only the last N events. Applied after `fromSeq` filter. */
  tail?: number;
}

export interface ReadEventsResult {
  events: RunEvent[];
  /** True if the last line of the file was a partial JSON write and was
   *  ignored. The next append should emit a `run.recovery` event. */
  truncatedTail: boolean;
  /** Highest seq observed in the file (after dropping a truncated tail). */
  maxSeq: number;
}

/** Stream all events from disk. Detects partial-JSON tail and signals
 *  recovery via `truncatedTail`. Does NOT throw on individual line parse
 *  errors that are NOT the last line — those produce a `partial_write`
 *  GuardrailError because mid-log corruption is unrecoverable here. */
export function readEvents(
  runDir: string,
  opts: ReadEventsOptions = {},
): ReadEventsResult {
  const p = eventsPath(runDir);
  if (!fs.existsSync(p)) {
    return { events: [], truncatedTail: false, maxSeq: 0 };
  }
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw) return { events: [], truncatedTail: false, maxSeq: 0 };

  // A well-formed ndjson file ends in '\n'. If the last char isn't '\n',
  // the file was truncated mid-write and the trailing fragment is junk.
  const endsWithNewline = raw.endsWith('\n');
  const lines = raw.split('\n');
  // After split, an ndjson file ending in '\n' produces a trailing '' that
  // we drop; a truncated file produces a non-empty trailing fragment that
  // we must also drop AND signal as truncated.
  let truncatedTail = false;
  let lastIdx = lines.length - 1;
  if (lines[lastIdx] === '') {
    // Normal case — trailing newline.
    lastIdx -= 1;
  } else if (!endsWithNewline) {
    truncatedTail = true;
    lastIdx -= 1;
  }

  const events: RunEvent[] = [];
  let maxSeq = 0;
  for (let i = 0; i <= lastIdx; i++) {
    const line = lines[i] as string;
    if (!line) continue; // skip blank lines defensively
    let parsed: RunEvent;
    try {
      parsed = JSON.parse(line) as RunEvent;
    } catch (err) {
      // The truncated tail (when present) is already excluded from the loop
      // by the `lastIdx -= 1` decrement above, so any parse failure here is
      // real mid-file corruption. Caught by Cursor Bugbot on PR #86 (MEDIUM):
      // the prior `i === lastIdx && !endsWithNewline` heuristic also matched
      // the LAST processed (well-terminated) line of a tail-truncated file
      // and silently swallowed genuine corruption on it.
      throw new GuardrailError(
        `events.ndjson: corrupt JSON at line ${i + 1}`,
        {
          code: 'partial_write',
          provider: 'run-state',
          details: { runDir, line: i + 1, error: (err as Error).message },
        },
      );
    }
    if (typeof parsed.seq === 'number' && parsed.seq > maxSeq) maxSeq = parsed.seq;
    events.push(parsed);
  }

  // Persist the partial-write marker so the next append knows to emit
  // a recovery event. We do this here on read because read is cheap and
  // happens once at writer-startup; appending a marker mid-read is racy
  // only in the multi-writer case which our advisory lock disallows.
  if (truncatedTail) {
    try {
      fs.writeFileSync(partialMarkerPath(runDir), '1', 'utf8');
    } catch {
      // intentionally swallowed
    }
  }

  let result = events;
  if (typeof opts.fromSeq === 'number') {
    const fromSeq = opts.fromSeq;
    result = result.filter(e => e.seq >= fromSeq);
  }
  if (typeof opts.tail === 'number' && opts.tail > 0) {
    result = result.slice(-opts.tail);
  }
  return { events: result, truncatedTail, maxSeq };
}

/** Read just the highest seq from disk. Prefers the sidecar; falls back to
 *  rescanning the events file. */
export function readMaxSeq(runDir: string): number {
  const sidecar = readSeqSidecar(runDir);
  if (sidecar !== null) return sidecar;
  return readEvents(runDir).maxSeq;
}

export interface AppendEventOptions {
  /** Override the runId stamped onto the event. Required for runs whose
   *  ID isn't derivable from the runDir (almost never; we accept it for
   *  test fixtures). */
  runId?: string;
  writerId: WriterId;
}

/** Append a single event to events.ndjson. Strict ordering:
 *    1. open(O_APPEND), write line, fsync(fd), close.
 *    2. Update sidecar with new seq (best-effort).
 *
 *  Returns the fully-formed RunEvent that landed on disk (with seq, ts,
 *  schema_version, etc. filled in).
 *
 *  This is the ONLY supported way to append. Bypassing it with raw fs writes
 *  will desync the seq sidecar and may break recovery. */
export function appendEvent(
  runDir: string,
  input: RunEventInput,
  opts: AppendEventOptions,
): RunEvent {
  fs.mkdirSync(runDir, { recursive: true });

  // If the previous open detected a truncated tail, drop a recovery event
  // FIRST so consumers see exactly one signal of the gap before any further
  // payload events. We clear the marker before the recursion so we don't
  // loop forever if the recovery write itself somehow lands and then bails.
  // The tail bytes (the partial JSON without a trailing newline) MUST be
  // truncated off before we append, otherwise the next event line gets
  // glued onto the corrupt bytes and we end up with a permanently broken
  // log even after recovery.
  const markerPath = partialMarkerPath(runDir);
  if (fs.existsSync(markerPath)) {
    try { fs.unlinkSync(markerPath); } catch { /* ignore */ }
    truncateToLastNewline(runDir);
    appendEventInner(runDir, {
      event: 'run.recovery',
      reason: 'recovered-from-partial-write',
    }, opts);
  }

  return appendEventInner(runDir, input, opts);
}

/** Truncate everything after the last newline in events.ndjson. Used during
 *  partial-write recovery to discard the trailing fragment so the next
 *  appended event lands on a fresh line. Best-effort — if anything goes
 *  wrong the appender will still produce JSON output, just on a malformed
 *  line; the seq gap detection will surface the problem on next replay. */
function truncateToLastNewline(runDir: string): void {
  const p = eventsPath(runDir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return;
  }
  if (raw.length === 0 || raw.endsWith('\n')) return;
  const lastNl = raw.lastIndexOf('\n');
  if (lastNl < 0) {
    // No newline at all — file is entirely partial. Wipe it.
    try { fs.writeFileSync(p, '', 'utf8'); } catch { /* ignore */ }
    invalidateSeqSidecar(runDir);
    return;
  }
  // Keep everything through the last '\n'.
  const kept = raw.slice(0, lastNl + 1);
  try { fs.writeFileSync(p, kept, 'utf8'); } catch { /* ignore */ }
  // The .seq sidecar may now reference a seq from the truncated fragment,
  // which would create a phantom gap on the next append → foldEvents
  // throws corrupted_state, breaking the very recovery path. Invalidate it
  // so the next readMaxSeq falls back to scanning the (now correct) file.
  // Caught by Cursor Bugbot on PR #86 (LOW).
  invalidateSeqSidecar(runDir);
}

function invalidateSeqSidecar(runDir: string): void {
  try { fs.unlinkSync(seqSidecarPath(runDir)); } catch { /* ignore — not present is fine */ }
}

function appendEventInner(
  runDir: string,
  input: RunEventInput,
  opts: AppendEventOptions,
): RunEvent {
  const runId = opts.runId ?? path.basename(runDir);
  const prevSeq = readMaxSeq(runDir);
  const seq = prevSeq + 1;
  const fullEvent = {
    schema_version: RUN_STATE_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    runId,
    seq,
    writerId: opts.writerId,
    ...input,
  } as RunEvent;

  const line = JSON.stringify(fullEvent) + '\n';
  const fd = fs.openSync(eventsPath(runDir), 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  writeSeqSidecar(runDir, seq);
  updateLockSeq(runDir, seq);
  return fullEvent;
}

// ----------------------------------------------------------------------------
// State replay. Folds events.ndjson into a RunState. Used both as:
//   a) the recovery path when state.json is missing/corrupt, and
//   b) a sanity check for tests / `runs doctor`.
// ----------------------------------------------------------------------------

const EMPTY_PHASE_SHELL = (
  name: string,
  index: number,
): PhaseSnapshot => ({
  schema_version: RUN_STATE_SCHEMA_VERSION,
  name,
  index,
  status: 'pending',
  idempotent: false,
  hasSideEffects: false,
  costUSD: 0,
  attempts: 0,
  artifacts: [],
  externalRefs: [],
});

/** Replay events.ndjson into a fresh RunState snapshot. The events file is
 *  the source of truth — this is always callable; if the file is missing or
 *  empty, the result is a minimal "pending" state with no phases.
 *
 *  Throws GuardrailError(corrupted_state) if the log has internal
 *  contradictions that prevent a coherent snapshot (e.g. seq gaps,
 *  phase.success without a prior phase.start), OR if the persisted
 *  `schema_version` falls outside this binary's supported window
 *  (`RUN_STATE_MIN_SUPPORTED_SCHEMA_VERSION..RUN_STATE_MAX_SUPPORTED_SCHEMA_VERSION`).
 *  Per v6.2.2 spec — the prior shape would fail with a cryptic
 *  `cannot read property 'phases' of undefined` instead of an actionable
 *  "this run dir is from a newer/older version" message. */
export function replayState(runDir: string): RunState {
  const { events } = readEvents(runDir);
  // v6.2.2 — version-window check. The bounds live in `state.ts` per the
  // spec, but a top-level import would close a cycle (state.ts already
  // imports `replayState` from this file). The values are derived from
  // RUN_STATE_SCHEMA_VERSION (already imported above), so we recompute them
  // locally — `state.ts` exposes the same shape via re-export.
  const minSupported = 1;
  const maxSupported = RUN_STATE_SCHEMA_VERSION;
  // Surface schema_version from the durable record. Each event carries the
  // writer's `schema_version`; the run.start event is the canonical
  // observation point because it's always first and always present after
  // createRun. If no events exist (fresh empty dir) we have nothing to check
  // and fall through to the existing empty-state path inside foldEvents.
  if (events.length > 0) {
    const observed = (events[0] as { schema_version?: number }).schema_version;
    if (
      typeof observed === 'number' &&
      (observed < minSupported || observed > maxSupported)
    ) {
      // v7.0 — when the observed version is HIGHER than this binary
      // supports, the run was written by a newer Autopilot. Surface the
      // "downgrade resume is not supported" hint so operators understand
      // why a v6 binary can't pick up a v7-written run dir.
      const downgradeHint = observed > maxSupported
        ? ` state was written by a newer Autopilot version (schema_version=${observed}; this binary supports [${minSupported}..${maxSupported}]); downgrade resume is not supported.`
        : '';
      throw new GuardrailError(
        `run dir at ${runDir} has schema_version ${observed}; this binary supports schema_version ${minSupported}..${maxSupported}.` +
        downgradeHint +
        ` Use the version of claude-autopilot that created this run dir, or delete the run dir to start fresh.`,
        {
          code: 'corrupted_state',
          provider: 'run-state',
          details: {
            runDir,
            observed,
            minSupported,
            maxSupported,
          },
        },
      );
    }
  }
  return foldEvents(runDir, events);
}

export function foldEvents(runDir: string, events: RunEvent[]): RunState {
  // Verify monotonic seq (no gaps, no duplicates) — the whole replay
  // contract depends on this. A gap means a writer crashed between
  // assigning seq and fsync; we treat that as corrupted_state and force
  // the user to acknowledge.
  for (let i = 0; i < events.length; i++) {
    const expected = i + 1;
    const got = (events[i] as RunEvent).seq;
    if (got !== expected) {
      throw new GuardrailError(
        `events.ndjson: seq gap at line ${i + 1} — expected ${expected}, got ${got}`,
        {
          code: 'corrupted_state',
          provider: 'run-state',
          details: { runDir, line: i + 1, expected, got },
        },
      );
    }
  }

  // Find the run.start to seed the state.
  const startEvent = events.find(e => e.event === 'run.start');
  if (!startEvent) {
    // No start event yet — return a stub. Used during the brief window
    // between mkdir and the first appendEvent call in createRun.
    return {
      schema_version: RUN_STATE_SCHEMA_VERSION,
      runId: path.basename(runDir),
      startedAt: new Date(0).toISOString(),
      status: 'pending',
      phases: [],
      currentPhaseIdx: 0,
      totalCostUSD: 0,
      lastEventSeq: 0,
      writerId: { pid: 0, hostHash: '' },
      cwd: '',
    };
  }
  if (startEvent.event !== 'run.start') {
    // Defensive — TS narrowing.
    throw new GuardrailError(
      `events.ndjson: first event is not run.start (got ${startEvent.event})`,
      {
        code: 'corrupted_state',
        provider: 'run-state',
        details: { runDir, firstEvent: startEvent.event },
      },
    );
  }

  const phases: PhaseSnapshot[] = startEvent.phases.map(
    (name: string, idx: number) => EMPTY_PHASE_SHELL(name, idx),
  );
  const state: RunState = {
    schema_version: RUN_STATE_SCHEMA_VERSION,
    runId: startEvent.runId,
    startedAt: startEvent.ts,
    status: 'pending',
    phases,
    currentPhaseIdx: 0,
    totalCostUSD: 0,
    lastEventSeq: events.length > 0 ? (events[events.length - 1] as RunEvent).seq : 0,
    writerId: startEvent.writerId,
    cwd: '',
    config: startEvent.config,
  };

  for (const ev of events) {
    applyEvent(state, ev);
  }

  return state;
}

function getPhase(state: RunState, idx: number, name: string): PhaseSnapshot {
  // Expand the phase array if a phase.start event arrives for an index
  // beyond the registered phases (defensive — shouldn't happen in normal
  // flow but lets recovery be lenient).
  while (state.phases.length <= idx) {
    state.phases.push(EMPTY_PHASE_SHELL(name, state.phases.length));
  }
  const p = state.phases[idx] as PhaseSnapshot;
  if (p.name !== name) {
    p.name = name; // accept rename if event disagrees with stub
  }
  return p;
}

function applyEvent(state: RunState, ev: RunEvent): void {
  state.lastEventSeq = ev.seq;
  switch (ev.event) {
    case 'run.start':
      // Already seeded above; nothing to do (idempotent here).
      state.status = 'pending';
      break;
    case 'run.complete':
      state.status = ev.status;
      state.endedAt = ev.ts;
      // totalCostUSD is also tallied per-phase; ev.totalCostUSD is the
      // writer's authoritative running total.
      state.totalCostUSD = ev.totalCostUSD;
      break;
    case 'run.warning':
    case 'run.recovery':
    case 'index.rebuilt':
    case 'lock.takeover':
    case 'budget.check':
      // Pure observability; no state mutation needed. The runner reads
      // events.ndjson directly to compute actualSoFar — replay does not
      // need to track budget decisions for state-correctness purposes.
      break;
    case 'task.started':
    case 'task.budget_reserved':
    case 'task.budget_increased_reservation':
    case 'task.budget_released':
    case 'task.completed':
    case 'task.failed':
    case 'task.merged':
    case 'task.merge_conflict':
    case 'task.merge_aborted':
    case 'task.timeout':
    case 'task.budget_halt':
      // v7.11.0 concurrent-dispatch task events. State for these lives in
      // the dispatch layer (budget-reservation ledger + scheduler), NOT in
      // the per-phase RunState snapshot — phases remain the coarse-grained
      // unit for the run-state engine. Replay is handled by
      // `budgetReservation.replayFromEvents()` for cost reconstruction and
      // by the scheduler's resume path for task-level state.
      break;
    case 'phase.start': {
      state.status = 'running';
      state.currentPhaseIdx = ev.phaseIdx;
      const p = getPhase(state, ev.phaseIdx, ev.phase);
      p.status = 'running';
      p.idempotent = ev.idempotent;
      p.hasSideEffects = ev.hasSideEffects;
      p.startedAt = ev.ts;
      p.attempts = ev.attempt;
      break;
    }
    case 'phase.success': {
      const p = getPhase(state, ev.phaseIdx, ev.phase);
      p.status = 'succeeded';
      p.endedAt = ev.ts;
      p.durationMs = ev.durationMs;
      p.artifacts = ev.artifacts.slice();
      // If this was the last phase, the next event should be run.complete;
      // we don't presume that here.
      break;
    }
    case 'phase.failed': {
      const p = getPhase(state, ev.phaseIdx, ev.phase);
      p.status = 'failed';
      p.endedAt = ev.ts;
      p.durationMs = ev.durationMs;
      p.lastError = ev.error;
      state.status = 'paused';
      break;
    }
    case 'phase.aborted': {
      const p = getPhase(state, ev.phaseIdx, ev.phase);
      p.status = 'aborted';
      p.endedAt = ev.ts;
      state.status = 'aborted';
      break;
    }
    case 'phase.cost': {
      const p = getPhase(state, ev.phaseIdx, ev.phase);
      p.costUSD += ev.costUSD;
      state.totalCostUSD += ev.costUSD;
      break;
    }
    case 'phase.externalRef': {
      const p = getPhase(state, ev.phaseIdx, ev.phase);
      const ref: ExternalRef = ev.ref;
      // Dedup by kind+id to keep replays idempotent on multiple emits.
      const dup = p.externalRefs.find(r => r.kind === ref.kind && r.id === ref.id);
      if (!dup) p.externalRefs.push(ref);
      break;
    }
    case 'phase.needs-human': {
      const p = getPhase(state, ev.phaseIdx, ev.phase);
      p.status = 'failed'; // surfaces as paused at the run level
      p.lastError = `needs-human: ${ev.reason}`;
      state.status = 'paused';
      break;
    }
    case 'replay.override': {
      // Phase 6 — purely advisory in the snapshot fold (the override itself
      // happened at decision time; the subsequent phase.start/.success or
      // .failed events drive state changes). We capture it on the phase's
      // meta so `runs show` can surface that an override was applied.
      const p = getPhase(state, ev.phaseIdx, ev.phase);
      const meta = (p.meta ?? {}) as Record<string, unknown>;
      const list = Array.isArray(meta.replayOverrides) ? meta.replayOverrides : [];
      list.push({ ts: ev.ts, reason: ev.reason, refsConsulted: ev.refsConsulted });
      meta.replayOverrides = list;
      p.meta = meta;
      break;
    }
    default: {
      // Exhaustiveness check. Adding a new event variant without updating
      // this switch will produce a TS error here at compile time.
      const _exhaustive: never = ev;
      void _exhaustive;
    }
  }
}

/** Fold an in-memory state into a list-row used by `runs list`. Lives here
 *  because it's a pure projection over RunState — no IO, no side effects. */
export function stateToIndexEntry(state: RunState, recovered = false): RunIndexEntry {
  // "Last phase" is the most recently advanced phase that isn't pending.
  let last: string | undefined;
  for (const p of state.phases) {
    if (p.status !== 'pending') last = p.name;
  }
  const entry: RunIndexEntry = {
    runId: state.runId,
    status: state.status,
    startedAt: state.startedAt,
    totalCostUSD: state.totalCostUSD,
  };
  if (state.endedAt !== undefined) entry.endedAt = state.endedAt;
  if (last !== undefined) entry.lastPhase = last;
  if (recovered) entry.recovered = true;
  return entry;
}
