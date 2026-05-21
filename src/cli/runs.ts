// src/cli/runs.ts
//
// v6 Phase 3 — user-facing CLI surface over the Phase 1 (persistence) and
// Phase 2 (phase wrapper) APIs. Six verbs, all read-only or scoped-delete:
//
//   runs list             — wrap listRuns; --status filter; newest-first
//   runs show <id>        — render state.json + tail of events.ndjson
//   runs gc               — wrap gcRuns; default 30d cutoff; confirmation
//   runs delete <id>      — explicit single-run delete, terminal-status only
//   run resume <id>       — LOOKUP-ONLY: identify nextPhase + decision
//   runs doctor           — replay events vs. state.json; report drift; --fix
//
// Phase 3 is read/inspect + GC. Actual phase execution on resume lands in
// Phase 6+; here `run resume` just answers "what would happen if I resumed?".
// This is documented in the function body and in `runs resume --help` text.
//
// Spec: docs/specs/v6-run-state-engine.md "Resume command", "CLI `--json`
// mode", "Migration path". `--json` envelope shape in Phase 3 is the v1
// surface; strict stdout/stderr channel discipline lands in Phase 5.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { GuardrailError } from '../core/errors.ts';
import { foldEvents, readEvents, stateToIndexEntry } from '../core/run-state/events.ts';
import { acquireRunLock } from '../core/run-state/lock.ts';
import {
  forceUnlockRepoLock,
  formatLockDiagnostic,
  isLockStale,
  peekRepoLock,
  type RepoLockMetadata,
} from '../core/run-state/repo-lock.ts';
import { decideReplay } from '../core/run-state/replay-decision.ts';
import { readStateSnapshot, statePath, writeStateSnapshot } from '../core/run-state/state.ts';
import { isValidULID } from '../core/run-state/ulid.ts';
import {
  gcRuns,
  listRuns,
  rebuildIndex,
  runDirFor,
  runsRoot,
} from '../core/run-state/runs.ts';
import type {
  ExternalRef,
  PhaseSnapshot,
  RunEvent,
  RunIndexEntry,
  RunState,
  RunStatus,
} from '../core/run-state/types.ts';

// ----------------------------------------------------------------------------
// Shared envelope shape for --json output. Phase 3 keeps the surface minimal;
// strict stdout/stderr discipline + per-command schema validation lands in
// Phase 5 (see spec "CLI --json mode + strict channel discipline").
// ----------------------------------------------------------------------------

const ENVELOPE_SCHEMA_VERSION = 1 as const;

interface RunsEnvelopeBase {
  schema_version: typeof ENVELOPE_SCHEMA_VERSION;
  command: string;
  status: 'pass' | 'fail';
  exit: number;
}

interface RunsCliResult {
  exit: number;
  /** Lines (will be newline-joined) for stdout under text mode. Under --json
   *  mode this is replaced by a single envelope JSON line. */
  stdout: string[];
  /** Lines for stderr under text mode. Phase 5 will move all human warnings
   *  into NDJSON events on stderr; Phase 3 keeps text-mode warnings here. */
  stderr: string[];
}

/** Validate that `runId` is a ULID. Throws GuardrailError(invalid_config) if
 *  not — keeps the surface uniform across verbs that take a runId. */
function assertValidRunId(runId: string | undefined): asserts runId is string {
  if (!runId) {
    throw new GuardrailError('a run id is required', {
      code: 'invalid_config',
      provider: 'runs-cli',
      details: { runId },
    });
  }
  if (!isValidULID(runId)) {
    throw new GuardrailError(`run id is not a valid ULID: ${runId}`, {
      code: 'invalid_config',
      provider: 'runs-cli',
      details: { runId },
    });
  }
}

/** Format a GuardrailError into a one-line `[code] message` string. */
function formatErr(err: unknown): string {
  if (err instanceof GuardrailError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Convert a result + json-mode flag into the final envelope when --json is
 *  set. The envelope is emitted as a single line on stdout; stderr lines from
 *  the result are dropped under --json (Phase 3 limitation; Phase 5 will route
 *  them as NDJSON events). */
function maybeEnvelope(
  command: string,
  json: boolean,
  result: RunsCliResult,
  payload: Record<string, unknown>,
): RunsCliResult {
  if (!json) return result;
  const envelope: RunsEnvelopeBase & Record<string, unknown> = {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    command,
    status: result.exit === 0 ? 'pass' : 'fail',
    exit: result.exit,
    ...payload,
  };
  return { exit: result.exit, stdout: [JSON.stringify(envelope)], stderr: [] };
}

// ----------------------------------------------------------------------------
// runs list
// ----------------------------------------------------------------------------

export interface RunRunsListOptions {
  cwd?: string;
  status?: string;
  json?: boolean;
}

const VALID_STATUS_FILTERS: ReadonlySet<RunStatus> = new Set([
  'pending',
  'running',
  'paused',
  'success',
  'failed',
  'aborted',
] as const);

/** `runs list` — newest-first listing. Optional --status filter narrows to
 *  one RunStatus. `--json` emits an envelope; text mode prints a tight
 *  table. */
export async function runRunsList(
  opts: RunRunsListOptions,
): Promise<RunsCliResult> {
  const cwd = opts.cwd ?? process.cwd();
  const json = !!opts.json;

  // The status filter shares the spec's RunStatus shape but the CLI accepts
  // a couple of common shorthands. We map "running" to 'running' (literal),
  // "completed" to 'success' (the spec's terminal-success status), and
  // "failed" to 'failed'. Anything else is rejected before we list.
  let statusFilter: RunStatus | undefined;
  if (opts.status) {
    const s = opts.status.toLowerCase();
    if (s === 'completed' || s === 'complete') statusFilter = 'success';
    else if (VALID_STATUS_FILTERS.has(s as RunStatus)) statusFilter = s as RunStatus;
    else {
      const err = new GuardrailError(
        `--status must be one of: pending, running, paused, completed, failed, aborted (got "${opts.status}")`,
        { code: 'invalid_config', provider: 'runs-cli', details: { status: opts.status } },
      );
      const result: RunsCliResult = {
        exit: 1,
        stdout: [],
        stderr: [`[claude-autopilot] runs list: ${formatErr(err)}`],
      };
      return maybeEnvelope('runs list', json, result, {
        error: formatErr(err),
      });
    }
  }

  let entries: RunIndexEntry[];
  try {
    entries = listRuns(cwd, { rebuild: true });
  } catch (err) {
    const result: RunsCliResult = {
      exit: 1,
      stdout: [],
      stderr: [`[claude-autopilot] runs list: ${formatErr(err)}`],
    };
    return maybeEnvelope('runs list', json, result, { error: formatErr(err) });
  }

  if (statusFilter) {
    entries = entries.filter(e => e.status === statusFilter);
  }

  if (json) {
    return maybeEnvelope(
      'runs list',
      true,
      { exit: 0, stdout: [], stderr: [] },
      { runs: entries, count: entries.length, ...(statusFilter ? { statusFilter } : {}) },
    );
  }

  if (entries.length === 0) {
    return {
      exit: 0,
      stdout: ['No runs.' + (statusFilter ? ` (filtered to status="${statusFilter}")` : '')],
      stderr: [],
    };
  }

  // Tight text table. Columns: runId | status | startedAt | cost | lastPhase
  const lines: string[] = [];
  lines.push(formatRunRow('runId', 'status', 'started', 'cost', 'lastPhase'));
  lines.push(formatRunRow('-----', '------', '-------', '----', '---------'));
  for (const e of entries) {
    lines.push(
      formatRunRow(
        e.runId,
        e.status + (e.recovered ? '*' : ''),
        e.startedAt,
        `$${e.totalCostUSD.toFixed(2)}`,
        e.lastPhase ?? '-',
      ),
    );
  }
  if (entries.some(e => e.recovered)) {
    lines.push('');
    lines.push('* state recovered from events.ndjson — run `claude-autopilot runs doctor` to inspect');
  }
  return { exit: 0, stdout: lines, stderr: [] };
}

const COL_RUNID = 28;
const COL_STATUS = 11;
const COL_STARTED = 26;
const COL_COST = 9;
function pad(s: string, n: number): string {
  if (s.length >= n) return s + ' ';
  return s + ' '.repeat(n - s.length);
}
function formatRunRow(
  runId: string,
  status: string,
  startedAt: string,
  cost: string,
  lastPhase: string,
): string {
  return (
    pad(runId, COL_RUNID) +
    pad(status, COL_STATUS) +
    pad(startedAt, COL_STARTED) +
    pad(cost, COL_COST) +
    lastPhase
  );
}

// ----------------------------------------------------------------------------
// runs show
// ----------------------------------------------------------------------------

export interface RunRunsShowOptions {
  runId: string;
  cwd?: string;
  /** Tail the events.ndjson log after the state summary. */
  events?: boolean;
  /** How many tail events to show with --events. Default 20. */
  eventsTail?: number;
  json?: boolean;
}

/** `runs show <id>` — render state.json (or replay if missing) plus, with
 *  --events, the tail of events.ndjson. JSON mode bundles state + events into
 *  the envelope. */
export async function runRunsShow(
  opts: RunRunsShowOptions,
): Promise<RunsCliResult> {
  const cwd = opts.cwd ?? process.cwd();
  const json = !!opts.json;
  const tail = opts.eventsTail ?? 20;

  try {
    assertValidRunId(opts.runId);
  } catch (err) {
    const result: RunsCliResult = {
      exit: 1,
      stdout: [],
      stderr: [`[claude-autopilot] runs show: ${formatErr(err)}`],
    };
    return maybeEnvelope('runs show', json, result, { error: formatErr(err) });
  }

  const runDir = runDirFor(cwd, opts.runId);
  if (!fs.existsSync(runDir)) {
    const err = new GuardrailError(`run not found: ${opts.runId}`, {
      code: 'not_found',
      provider: 'runs-cli',
      details: { runId: opts.runId, runDir },
    });
    const result: RunsCliResult = {
      exit: 1,
      stdout: [],
      stderr: [`[claude-autopilot] runs show: ${formatErr(err)}`],
    };
    return maybeEnvelope('runs show', json, result, { error: formatErr(err), runId: opts.runId });
  }

  // Read state.json — if missing/corrupt, fall back to in-memory replay so
  // we never modify the run during a read-only show.
  let state: RunState | null = null;
  let recovered = false;
  try {
    state = readStateSnapshot(runDir);
  } catch {
    recovered = true;
  }
  if (!state) {
    try {
      const { events: replayEvents } = readEvents(runDir);
      state = foldEvents(runDir, replayEvents);
      recovered = true;
    } catch (err) {
      const result: RunsCliResult = {
        exit: 1,
        stdout: [],
        stderr: [`[claude-autopilot] runs show: ${formatErr(err)}`],
      };
      return maybeEnvelope('runs show', json, result, {
        error: formatErr(err),
        runId: opts.runId,
      });
    }
  }

  // Optional event tail (always read so JSON mode can include it; text mode
  // prints only when --events is set).
  let tailEvents: RunEvent[] = [];
  if (opts.events || json) {
    try {
      tailEvents = readEvents(runDir, { tail }).events;
    } catch (err) {
      // Mid-log corruption — surface as warning, keep the snapshot.
      tailEvents = [];
      if (!json) {
        return {
          exit: 1,
          stdout: [],
          stderr: [`[claude-autopilot] runs show: events.ndjson corrupt — ${formatErr(err)}`],
        };
      }
    }
  }

  if (json) {
    return maybeEnvelope(
      'runs show',
      true,
      { exit: 0, stdout: [], stderr: [] },
      {
        runId: opts.runId,
        state,
        recovered,
        events: tailEvents,
        eventsTail: tail,
      },
    );
  }

  // Text mode — header + phase checklist.
  const lines: string[] = [];
  lines.push(`run ${state.runId}  status=${state.status}${recovered ? ' (recovered)' : ''}`);
  lines.push(`  started: ${state.startedAt}`);
  if (state.endedAt) lines.push(`  ended:   ${state.endedAt}`);
  lines.push(`  cost:    $${state.totalCostUSD.toFixed(4)}`);
  lines.push(`  cwd:     ${state.cwd || '(unknown)'}`);
  lines.push('');
  lines.push('phases:');
  for (const p of state.phases) {
    lines.push(formatPhaseRow(p, p.index === state.currentPhaseIdx));
    if (p.lastError) {
      lines.push(`      error: ${p.lastError}`);
    }
    if (p.externalRefs.length > 0) {
      for (const r of p.externalRefs) {
        lines.push(`      ref: ${r.kind}=${r.id}${r.url ? ` (${r.url})` : ''}`);
      }
    }
  }
  if (opts.events) {
    lines.push('');
    lines.push(`events (last ${tailEvents.length}):`);
    for (const ev of tailEvents) {
      lines.push(`  ${ev.seq.toString().padStart(4)} ${ev.ts} ${ev.event}`);
    }
  }
  return { exit: 0, stdout: lines, stderr: [] };
}

function statusGlyph(status: PhaseSnapshot['status']): string {
  switch (status) {
    case 'succeeded':
      return '[x]';
    case 'failed':
      return '[!]';
    case 'running':
      return '[>]';
    case 'aborted':
      return '[-]';
    case 'skipped':
      return '[~]';
    case 'pending':
    default:
      return '[ ]';
  }
}

function formatPhaseRow(p: PhaseSnapshot, isCurrent: boolean): string {
  const arrow = isCurrent ? ' <-' : '';
  const cost = `$${p.costUSD.toFixed(4)}`;
  const dur = p.durationMs !== undefined ? `${p.durationMs}ms` : '-';
  return `  ${statusGlyph(p.status)} ${p.name.padEnd(14)} ${cost.padEnd(10)} ${dur.padEnd(8)} attempts=${p.attempts}${arrow}`;
}

// ----------------------------------------------------------------------------
// runs gc
// ----------------------------------------------------------------------------

export interface RunRunsGcOptions {
  cwd?: string;
  /** Default 30. */
  olderThanDays?: number;
  dryRun?: boolean;
  json?: boolean;
  /** Skip the interactive confirmation prompt. */
  yes?: boolean;
}

/** `runs gc` — wraps gcRuns with confirmation. Default cutoff 30 days. With
 *  --dry-run, lists what would be removed without touching disk. */
export async function runRunsGc(
  opts: RunRunsGcOptions,
): Promise<RunsCliResult> {
  const cwd = opts.cwd ?? process.cwd();
  const json = !!opts.json;
  const olderThanDays = opts.olderThanDays ?? 30;

  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    const err = new GuardrailError(
      `--older-than-days must be a non-negative number (got ${olderThanDays})`,
      { code: 'invalid_config', provider: 'runs-cli', details: { olderThanDays } },
    );
    const result: RunsCliResult = {
      exit: 1,
      stdout: [],
      stderr: [`[claude-autopilot] runs gc: ${formatErr(err)}`],
    };
    return maybeEnvelope('runs gc', json, result, { error: formatErr(err) });
  }

  // Always start with a dry-run pass so we can preview + ask.
  const preview = gcRuns(cwd, { olderThanDays, dryRun: true });

  if (preview.deleted.length === 0) {
    const result: RunsCliResult = {
      exit: 0,
      stdout: [
        `runs gc: nothing to delete (cutoff ${olderThanDays} days; ${preview.kept.length} kept, ${preview.skippedUnsafe.length} skipped unsafe)`,
      ],
      stderr: [],
    };
    return maybeEnvelope('runs gc', json, result, {
      olderThanDays,
      candidates: [],
      deleted: [],
      kept: preview.kept,
      skippedUnsafe: preview.skippedUnsafe,
      dryRun: true,
    });
  }

  if (opts.dryRun) {
    const lines = [
      `runs gc (dry-run): would delete ${preview.deleted.length} run(s)`,
      ...preview.deleted.map(id => `  - ${id}`),
      `kept ${preview.kept.length}, skipped unsafe ${preview.skippedUnsafe.length}`,
    ];
    return maybeEnvelope(
      'runs gc',
      json,
      { exit: 0, stdout: lines, stderr: [] },
      {
        olderThanDays,
        candidates: preview.deleted,
        deleted: [],
        kept: preview.kept,
        skippedUnsafe: preview.skippedUnsafe,
        dryRun: true,
      },
    );
  }

  // Confirmation. --yes skips; --json implies non-interactive — we require
  // --yes there to avoid blocking a CI invocation.
  if (!opts.yes) {
    if (json || !process.stdin.isTTY) {
      const err = new GuardrailError(
        `non-interactive: pass --yes to confirm deletion of ${preview.deleted.length} run(s)`,
        {
          code: 'invalid_config',
          provider: 'runs-cli',
          details: { candidates: preview.deleted },
        },
      );
      const result: RunsCliResult = {
        exit: 1,
        stdout: [],
        stderr: [`[claude-autopilot] runs gc: ${formatErr(err)}`],
      };
      return maybeEnvelope('runs gc', json, result, {
        error: formatErr(err),
        candidates: preview.deleted,
      });
    }
    const confirmed = await confirmInteractive(
      `Delete ${preview.deleted.length} run(s) older than ${olderThanDays} days? [y/N] `,
    );
    if (!confirmed) {
      return {
        exit: 0,
        stdout: ['runs gc: aborted'],
        stderr: [],
      };
    }
  }

  // Real pass.
  const real = gcRuns(cwd, { olderThanDays });
  const lines = [
    `runs gc: deleted ${real.deleted.length} run(s)`,
    ...real.deleted.map(id => `  - ${id}`),
    `kept ${real.kept.length}, skipped unsafe ${real.skippedUnsafe.length}`,
  ];
  return maybeEnvelope(
    'runs gc',
    json,
    { exit: 0, stdout: lines, stderr: [] },
    {
      olderThanDays,
      deleted: real.deleted,
      kept: real.kept,
      skippedUnsafe: real.skippedUnsafe,
      dryRun: false,
    },
  );
}

async function confirmInteractive(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer: string = await new Promise(resolve => rl.question(prompt, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// ----------------------------------------------------------------------------
// runs delete
// ----------------------------------------------------------------------------

export interface RunRunsDeleteOptions {
  runId: string;
  cwd?: string;
  /** Override the terminal-status guard. */
  force?: boolean;
  json?: boolean;
}

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['success', 'failed', 'aborted']);

/** `runs delete <id>` — explicit single-run delete. Refuses non-terminal
 *  status without --force; refuses if the run lock is currently held by
 *  another writer.
 *
 *  We acquire the lock for the duration of the delete so we never race a
 *  concurrent writer. Lock acquisition uses a tiny timeout — we want
 *  fail-fast over blocking. */
export async function runRunsDelete(
  opts: RunRunsDeleteOptions,
): Promise<RunsCliResult> {
  const cwd = opts.cwd ?? process.cwd();
  const json = !!opts.json;

  try {
    assertValidRunId(opts.runId);
  } catch (err) {
    const result: RunsCliResult = {
      exit: 1,
      stdout: [],
      stderr: [`[claude-autopilot] runs delete: ${formatErr(err)}`],
    };
    return maybeEnvelope('runs delete', json, result, { error: formatErr(err) });
  }

  const runDir = runDirFor(cwd, opts.runId);
  if (!fs.existsSync(runDir)) {
    const err = new GuardrailError(`run not found: ${opts.runId}`, {
      code: 'not_found',
      provider: 'runs-cli',
      details: { runId: opts.runId, runDir },
    });
    const result: RunsCliResult = {
      exit: 1,
      stdout: [],
      stderr: [`[claude-autopilot] runs delete: ${formatErr(err)}`],
    };
    return maybeEnvelope('runs delete', json, result, {
      error: formatErr(err),
      runId: opts.runId,
    });
  }

  // Refuse if non-terminal without --force.
  let status: RunStatus | 'unknown' = 'unknown';
  try {
    const snap = readStateSnapshot(runDir);
    if (snap) status = snap.status;
  } catch {
    // Treat corrupt as unknown — we still let --force win below.
  }
  if (!opts.force && status !== 'unknown' && !TERMINAL_STATUSES.has(status as RunStatus)) {
    const err = new GuardrailError(
      `run ${opts.runId} status=${status} is not terminal — refusing delete without --force`,
      {
        code: 'invalid_config',
        provider: 'runs-cli',
        details: { runId: opts.runId, status },
      },
    );
    const result: RunsCliResult = {
      exit: 1,
      stdout: [],
      stderr: [`[claude-autopilot] runs delete: ${formatErr(err)}`],
    };
    return maybeEnvelope('runs delete', json, result, {
      error: formatErr(err),
      runId: opts.runId,
      status,
    });
  }

  // Lock acquisition. If the lock is held we surface lock_held.
  let lock;
  try {
    lock = await acquireRunLock(runDir, { retries: 0 });
  } catch (err) {
    const result: RunsCliResult = {
      exit: 1,
      stdout: [],
      stderr: [`[claude-autopilot] runs delete: ${formatErr(err)}`],
    };
    return maybeEnvelope('runs delete', json, result, {
      error: formatErr(err),
      runId: opts.runId,
    });
  }

  try {
    fs.rmSync(runDir, { recursive: true, force: true });
  } catch (err) {
    await lock.release().catch(() => {});
    const result: RunsCliResult = {
      exit: 1,
      stdout: [],
      stderr: [`[claude-autopilot] runs delete: rm failed: ${formatErr(err)}`],
    };
    return maybeEnvelope('runs delete', json, result, {
      error: formatErr(err),
      runId: opts.runId,
    });
  }
  // Refresh the index — best-effort.
  try { rebuildIndex(cwd); } catch { /* index is cache */ }

  // The lock handle's underlying file is gone — release() will no-op gracefully.
  await lock.release().catch(() => {});

  return maybeEnvelope(
    'runs delete',
    json,
    {
      exit: 0,
      stdout: [`runs delete: removed ${opts.runId}`],
      stderr: [],
    },
    { runId: opts.runId, deleted: true, status },
  );
}

// ----------------------------------------------------------------------------
// run resume — LOOKUP ONLY for Phase 3
// ----------------------------------------------------------------------------

export type ResumeDecision =
  | 'retry'
  | 'skip-idempotent'
  | 'needs-human'
  | 'already-complete';

export interface RunResumeLookup {
  runId: string;
  status: RunStatus;
  currentPhase: string | null;
  nextPhase: string | null;
  decision: ResumeDecision;
  reason: string;
  externalRefs: ExternalRef[];
}

export interface RunRunResumeOptions {
  runId: string;
  cwd?: string;
  /** Optional explicit phase to resume from (by name). Surfaces as a
   *  validation hint here; actual execution lands in Phase 6+. */
  fromPhase?: string;
  json?: boolean;
}

/** `run resume <id>` — Phase 3 LOOKUP ONLY.
 *
 *  This verb identifies which phase a future resume would pick up from and
 *  the decision the engine would make per the spec's idempotency table. It
 *  does NOT execute the phase — that wires in Phase 6+ once the budget
 *  enforcer (Phase 4) and the JSON event stream (Phase 5) are in place.
 *
 *  Decision rules (mirror `runPhase` in src/core/run-state/phase-runner.ts):
 *    - already-complete  : run.status === 'success' or every phase succeeded
 *    - skip-idempotent   : nextPhase has a prior phase.success AND idempotent
 *    - needs-human       : nextPhase has a prior phase.success AND side-effects
 *    - retry             : default (no prior success — first attempt or retry
 *                          of a failed attempt) */
export async function runRunResume(
  opts: RunRunResumeOptions,
): Promise<RunsCliResult> {
  const cwd = opts.cwd ?? process.cwd();
  const json = !!opts.json;

  try {
    assertValidRunId(opts.runId);
  } catch (err) {
    const result: RunsCliResult = {
      exit: 1,
      stdout: [],
      stderr: [`[claude-autopilot] run resume: ${formatErr(err)}`],
    };
    return maybeEnvelope('run resume', json, result, { error: formatErr(err) });
  }

  const runDir = runDirFor(cwd, opts.runId);
  if (!fs.existsSync(runDir)) {
    const err = new GuardrailError(`run not found: ${opts.runId}`, {
      code: 'not_found',
      provider: 'runs-cli',
      details: { runId: opts.runId, runDir },
    });
    const result: RunsCliResult = {
      exit: 1,
      stdout: [],
      stderr: [`[claude-autopilot] run resume: ${formatErr(err)}`],
    };
    return maybeEnvelope('run resume', json, result, {
      error: formatErr(err),
      runId: opts.runId,
    });
  }

  // Always replay events in-memory so the lookup is cheap and never mutates.
  let state: RunState;
  try {
    const fromSnap = readStateSnapshot(runDir);
    if (fromSnap) state = fromSnap;
    else state = foldEvents(runDir, readEvents(runDir).events);
  } catch (err) {
    // Fall back to events replay; if THAT fails, surface.
    try {
      state = foldEvents(runDir, readEvents(runDir).events);
    } catch {
      const result: RunsCliResult = {
        exit: 1,
        stdout: [],
        stderr: [`[claude-autopilot] run resume: ${formatErr(err)}`],
      };
      return maybeEnvelope('run resume', json, result, {
        error: formatErr(err),
        runId: opts.runId,
      });
    }
  }

  const lookup = computeResumeLookup(state, opts.fromPhase);

  // Validate --from-phase if provided.
  if (opts.fromPhase && !state.phases.some(p => p.name === opts.fromPhase)) {
    const err = new GuardrailError(
      `--from-phase "${opts.fromPhase}" is not a phase of run ${opts.runId}`,
      {
        code: 'invalid_config',
        provider: 'runs-cli',
        details: { fromPhase: opts.fromPhase, phases: state.phases.map(p => p.name) },
      },
    );
    const result: RunsCliResult = {
      exit: 1,
      stdout: [],
      stderr: [`[claude-autopilot] run resume: ${formatErr(err)}`],
    };
    return maybeEnvelope('run resume', json, result, {
      error: formatErr(err),
      runId: opts.runId,
    });
  }

  if (json) {
    return maybeEnvelope(
      'run resume',
      true,
      { exit: 0, stdout: [], stderr: [] },
      {
        ...lookup,
        lookupOnly: true,
        note: 'Phase 3 of v6 is lookup-only. Execution wires in Phase 6+.',
      },
    );
  }

  const lines: string[] = [];
  lines.push(`run ${lookup.runId}  status=${lookup.status}`);
  lines.push(`  currentPhase: ${lookup.currentPhase ?? '(none)'}`);
  lines.push(`  nextPhase:    ${lookup.nextPhase ?? '(none)'}`);
  lines.push(`  decision:     ${lookup.decision}`);
  lines.push(`  reason:       ${lookup.reason}`);
  if (lookup.externalRefs.length > 0) {
    lines.push('  externalRefs:');
    for (const r of lookup.externalRefs) {
      lines.push(`    ${r.kind}=${r.id}${r.url ? ` (${r.url})` : ''}`);
    }
  }
  lines.push('');
  lines.push('NOTE: this is a lookup-only verb in v6 Phase 3.');
  lines.push('      Actual phase execution wires in Phase 6+. Use it to confirm');
  lines.push('      the engine would do the right thing before that lands.');
  return { exit: 0, stdout: lines, stderr: [] };
}

/** Pure projection over a RunState that decides the next phase + replay rule.
 *  Exported for tests. */
export function computeResumeLookup(
  state: RunState,
  fromPhase?: string,
): RunResumeLookup {
  const externalRefs: ExternalRef[] = [];
  for (const p of state.phases) externalRefs.push(...p.externalRefs);

  // Already-complete short-circuit: every phase succeeded OR run.status is
  // success. Either condition is enough.
  if (state.status === 'success' || state.phases.every(p => p.status === 'succeeded')) {
    const last = state.phases[state.phases.length - 1];
    return {
      runId: state.runId,
      status: state.status,
      currentPhase: last?.name ?? null,
      nextPhase: null,
      decision: 'already-complete',
      reason: 'all phases succeeded — nothing to resume',
      externalRefs,
    };
  }

  // Find the resume target. Either the explicit --from-phase or the first
  // non-succeeded phase by index.
  let target: PhaseSnapshot | undefined;
  if (fromPhase) {
    target = state.phases.find(p => p.name === fromPhase);
  } else {
    target = state.phases.find(p => p.status !== 'succeeded');
  }
  if (!target) {
    return {
      runId: state.runId,
      status: state.status,
      currentPhase: null,
      nextPhase: null,
      decision: 'already-complete',
      reason: 'no resumable phase identified',
      externalRefs,
    };
  }

  const currentName = state.phases[state.currentPhaseIdx]?.name ?? null;

  // Phase 6 — delegate to the canonical decideReplay() so the CLI
  // prediction matches what runPhase will actually do. This is "lookup
  // mode" — we pass an empty readbacks array, which (per the matrix)
  // collapses every prior-success-with-side-effects case to needs-human
  // because we can't perform a live readback from inside the CLI lookup.
  // That's the right answer: surface the question to the user before
  // actual execution. The CLI prediction's `skip-idempotent` /
  // `already-complete` decisions are convenience aliases over decideReplay's
  // `skip-already-applied` so existing consumers keep their vocabulary.
  const hasPriorSuccess = target.status === 'succeeded';
  const decision = decideReplay({
    phaseName: target.name,
    hasPriorSuccess,
    priorAttempts: target.attempts,
    idempotent: target.idempotent,
    hasSideEffects: target.hasSideEffects,
    externalRefs: target.externalRefs,
    readbacks: [], // pure-state lookup; live readbacks happen inside runPhase
    forceReplay: false,
  });

  // Bugbot LOW (PR #91): exhaustive switch — no `default` branch so TypeScript
  // catches a missing case at compile time if a new ReplayDecisionKind variant
  // is added. The `never` assignment is the standard pattern (mirrors the
  // foldEvents switch in events.ts).
  let mappedDecision: ResumeDecision;
  switch (decision.decision) {
    case 'retry':
      mappedDecision = 'retry';
      break;
    case 'needs-human':
    case 'abort':
      mappedDecision = 'needs-human';
      break;
    case 'skip-already-applied':
      // Map to the existing CLI vocabulary: idempotent phases keep their
      // skip-idempotent label; everything else surfaces as already-complete
      // so existing CLI consumers don't need to learn a new verb.
      mappedDecision = target.idempotent ? 'skip-idempotent' : 'already-complete';
      break;
    default: {
      const _exhaustive: never = decision.decision;
      throw new Error(`unreachable ReplayDecisionKind: ${String(_exhaustive)}`);
    }
  }

  return {
    runId: state.runId,
    status: state.status,
    currentPhase: currentName,
    nextPhase: target.name,
    decision: mappedDecision,
    reason: decision.reason,
    externalRefs: target.externalRefs.length > 0 ? target.externalRefs : externalRefs,
  };
}

// ----------------------------------------------------------------------------
// runs doctor
// ----------------------------------------------------------------------------

export interface RunRunsDoctorOptions {
  cwd?: string;
  /** Limit the check to a single run id. */
  runId?: string;
  /** Rewrite state.json from the events.ndjson replay where drift is found. */
  fix?: boolean;
  json?: boolean;
}

export interface RunsDoctorRunReport {
  runId: string;
  drift: 'none' | 'snapshot-vs-replay' | 'snapshot-missing' | 'snapshot-corrupt' | 'events-corrupt';
  details?: string;
  fixed?: boolean;
}

/** `runs doctor` — replay events.ndjson per run, compare against state.json,
 *  report drift. With --fix, rewrite state.json from the replay where drift
 *  exists.
 *
 *  Drift categories:
 *    snapshot-vs-replay : both readable but disagree on a key field
 *    snapshot-missing   : state.json absent, replay successful
 *    snapshot-corrupt   : state.json present but unparseable
 *    events-corrupt     : events.ndjson can't be folded (bigger problem)
 */
export async function runRunsDoctor(
  opts: RunRunsDoctorOptions,
): Promise<RunsCliResult> {
  const cwd = opts.cwd ?? process.cwd();
  const json = !!opts.json;
  const root = runsRoot(cwd);

  if (!fs.existsSync(root)) {
    return maybeEnvelope(
      'runs doctor',
      json,
      { exit: 0, stdout: ['runs doctor: no runs directory.'], stderr: [] },
      { runs: [] },
    );
  }

  // Decide the run set.
  let runIds: string[];
  if (opts.runId) {
    try {
      assertValidRunId(opts.runId);
    } catch (err) {
      const result: RunsCliResult = {
        exit: 1,
        stdout: [],
        stderr: [`[claude-autopilot] runs doctor: ${formatErr(err)}`],
      };
      return maybeEnvelope('runs doctor', json, result, { error: formatErr(err) });
    }
    runIds = [opts.runId];
  } else {
    runIds = fs
      .readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .filter(isValidULID);
  }

  const reports: RunsDoctorRunReport[] = [];
  let driftCount = 0;

  for (const runId of runIds) {
    const runDir = path.join(root, runId);
    if (!fs.existsSync(runDir)) {
      reports.push({ runId, drift: 'snapshot-missing', details: 'run dir not found' });
      driftCount += 1;
      continue;
    }

    let snapshot: RunState | null = null;
    let snapErr: string | null = null;
    try {
      snapshot = readStateSnapshot(runDir);
    } catch (err) {
      snapErr = formatErr(err);
    }

    let replayed: RunState | null = null;
    let replayErr: string | null = null;
    try {
      const evRead = readEvents(runDir);
      replayed = foldEvents(runDir, evRead.events);
    } catch (err) {
      replayErr = formatErr(err);
    }

    if (replayErr) {
      reports.push({ runId, drift: 'events-corrupt', details: replayErr });
      driftCount += 1;
      continue;
    }
    if (!snapshot && !snapErr) {
      // snapshot missing
      reports.push({ runId, drift: 'snapshot-missing', details: 'state.json absent' });
      driftCount += 1;
      if (opts.fix && replayed) {
        try {
          writeStateSnapshot(runDir, replayed);
          reports[reports.length - 1]!.fixed = true;
        } catch (err) {
          reports[reports.length - 1]!.details = `fix failed: ${formatErr(err)}`;
        }
      }
      continue;
    }
    if (snapErr) {
      reports.push({ runId, drift: 'snapshot-corrupt', details: snapErr });
      driftCount += 1;
      if (opts.fix && replayed) {
        try {
          writeStateSnapshot(runDir, replayed);
          reports[reports.length - 1]!.fixed = true;
        } catch (err) {
          reports[reports.length - 1]!.details = `fix failed: ${formatErr(err)}`;
        }
      }
      continue;
    }

    // Both readable — compare key fields.
    const drift = diffStates(snapshot as RunState, replayed as RunState);
    if (drift) {
      reports.push({ runId, drift: 'snapshot-vs-replay', details: drift });
      driftCount += 1;
      if (opts.fix && replayed) {
        try {
          writeStateSnapshot(runDir, replayed);
          reports[reports.length - 1]!.fixed = true;
        } catch (err) {
          reports[reports.length - 1]!.details = `${drift}; fix failed: ${formatErr(err)}`;
        }
      }
    } else {
      reports.push({ runId, drift: 'none' });
    }
  }

  const exit = driftCount > 0 && !opts.fix ? 1 : 0;

  if (json) {
    return maybeEnvelope(
      'runs doctor',
      true,
      { exit, stdout: [], stderr: [] },
      { runs: reports, driftCount, fixApplied: !!opts.fix },
    );
  }

  const lines: string[] = [];
  if (reports.length === 0) {
    lines.push('runs doctor: no runs found.');
  } else {
    for (const r of reports) {
      const tag = r.drift === 'none' ? 'OK' : r.drift.toUpperCase();
      const fixedNote = r.fixed ? ' (fixed)' : '';
      lines.push(`  ${tag.padEnd(20)} ${r.runId}${fixedNote}${r.details ? ` — ${r.details}` : ''}`);
    }
    lines.push('');
    lines.push(`runs doctor: ${reports.length} run(s) checked, ${driftCount} drift finding(s)`);
    if (driftCount > 0 && !opts.fix) {
      lines.push('  hint: re-run with --fix to rewrite state.json from events.ndjson');
    }
  }
  return { exit, stdout: lines, stderr: [] };
}

/** Diff two RunStates on key fields. Returns a one-line description of the
 *  first divergence or null if equivalent. */
function diffStates(a: RunState, b: RunState): string | null {
  if (a.runId !== b.runId) return `runId mismatch (${a.runId} vs ${b.runId})`;
  if (a.status !== b.status) return `status mismatch (${a.status} vs ${b.status})`;
  if (a.lastEventSeq !== b.lastEventSeq) {
    return `lastEventSeq mismatch (${a.lastEventSeq} vs ${b.lastEventSeq})`;
  }
  // Cost compared with a small epsilon for float jitter.
  if (Math.abs(a.totalCostUSD - b.totalCostUSD) > 1e-9) {
    return `totalCostUSD mismatch (${a.totalCostUSD} vs ${b.totalCostUSD})`;
  }
  if (a.phases.length !== b.phases.length) {
    return `phase count mismatch (${a.phases.length} vs ${b.phases.length})`;
  }
  for (let i = 0; i < a.phases.length; i++) {
    const pa = a.phases[i] as PhaseSnapshot;
    const pb = b.phases[i] as PhaseSnapshot;
    if (pa.status !== pb.status) {
      return `phases[${i}] (${pa.name}) status mismatch (${pa.status} vs ${pb.status})`;
    }
    if (pa.attempts !== pb.attempts) {
      return `phases[${i}] (${pa.name}) attempts mismatch (${pa.attempts} vs ${pb.attempts})`;
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// runs cleanup --force-unlock — v7.11.0 PR 2/6 stale repo-lock recovery
// ----------------------------------------------------------------------------
//
// The repo lock (Layer 2 of v7.11.0 critical-section serialization) is NEVER
// auto-cleared — even when stale (PID dead AND >1h old). The user must
// confirm via this subcommand. We do NOT probe holder liveness on the
// user's behalf here: that's done inside `acquireRepoLock`, and the user
// has already seen the stale-lock diagnostic before running this command.
//
// Spec: `Stale-lock handling ... Do NOT auto-clear stale locks without
// user confirmation; a still-running process on another tty could be
// writing.`

export interface RunRunsCleanupOptions {
  cwd?: string;
  /** Required — currently the only operation. Future cleanup verbs (e.g.
   *  `--gc-worktrees`) would be additional bool flags on the same subcommand. */
  forceUnlock: boolean;
  /** Bypass the interactive `yes` prompt. Used by scripts (not exposed in
   *  the README as an example — we want manual operators to type yes). */
  yes?: boolean;
  /** Override the repo-lock path. Defaults to
   *  `<cwd>/.claude/run-state/repo.lock`. Tests use this. */
  lockPath?: string;
  /** Custom stdin reader for tests. Defaults to a node:readline-bound
   *  interface against process.stdin. */
  promptFn?: (question: string) => Promise<string>;
  json?: boolean;
}

/** Default user prompt — single line, expects exactly the string `yes`. */
function defaultPromptFn(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Resolve the default repo-lock path relative to a given cwd. */
function defaultRepoLockPath(cwd: string): string {
  return path.join(cwd, '.claude', 'run-state', 'repo.lock');
}

/**
 * `runs cleanup --force-unlock` — surface the holder, require explicit
 * `yes` confirmation, then unlink the lock metadata + the proper-lockfile
 * `.lock` directory. Idempotent: if nothing is held, returns success with
 * a "nothing to do" message.
 */
export async function runRunsCleanup(
  opts: RunRunsCleanupOptions,
): Promise<RunsCliResult> {
  const cwd = opts.cwd ?? process.cwd();
  const json = !!opts.json;
  const lockPath = opts.lockPath ?? defaultRepoLockPath(cwd);

  if (!opts.forceUnlock) {
    const err = new GuardrailError(
      'runs cleanup requires an operation flag — currently only --force-unlock is supported',
      {
        code: 'invalid_config',
        provider: 'runs-cli',
        details: { lockPath },
      },
    );
    return maybeEnvelope(
      'runs cleanup',
      json,
      {
        exit: 1,
        stdout: [],
        stderr: [`[claude-autopilot] runs cleanup: ${formatErr(err)}`],
      },
      { error: formatErr(err) },
    );
  }

  // Read existing metadata. Missing meta + missing lock dir = nothing to
  // clean; we say so and exit 0 (idempotent).
  const meta: RepoLockMetadata | null = peekRepoLock(lockPath);
  const lockDirExists = fs.existsSync(lockPath + '.lock');

  if (!meta && !lockDirExists) {
    return maybeEnvelope(
      'runs cleanup',
      json,
      {
        exit: 0,
        stdout: [`runs cleanup: no repo lock at ${lockPath} — nothing to do`],
        stderr: [],
      },
      { lockPath, cleared: false, reason: 'no-lock-present' },
    );
  }

  // Print the diagnostic so the user knows exactly what they're clearing.
  const diagnosticLines: string[] = [];
  if (meta) {
    diagnosticLines.push(formatLockDiagnostic(meta, lockPath));
  } else {
    diagnosticLines.push(
      `Repo lock at ${lockPath} exists but has no metadata sidecar.`,
      '(The holder likely crashed between acquiring the lock and writing metadata.)',
    );
  }

  // Confirmation — REQUIRED in text mode, may be bypassed by --yes in
  // scripted mode. JSON mode without --yes is rejected: we will not
  // dump a confirmation prompt to JSON consumers.
  if (!opts.yes) {
    if (json) {
      const err = new GuardrailError(
        'runs cleanup --force-unlock requires --yes when used with --json',
        {
          code: 'invalid_config',
          provider: 'runs-cli',
          details: { lockPath },
        },
      );
      return maybeEnvelope(
        'runs cleanup',
        json,
        {
          exit: 1,
          stdout: [],
          stderr: [`[claude-autopilot] runs cleanup: ${formatErr(err)}`],
        },
        { error: formatErr(err), lockPath },
      );
    }

    // Print diagnostic to stderr so it appears even under output piping.
    for (const line of diagnosticLines) {
      process.stderr.write(`${line}\n`);
    }
    process.stderr.write('\n');

    const prompt = opts.promptFn ?? defaultPromptFn;
    const answer = (await prompt('Type "yes" to force-unlock: ')).trim();
    if (answer !== 'yes') {
      return {
        exit: 1,
        stdout: [],
        stderr: [`runs cleanup: aborted (confirmation not "yes")`],
      };
    }
  }

  const removed = forceUnlockRepoLock(lockPath);
  const stale = meta ? isLockStale(meta) : null;

  return maybeEnvelope(
    'runs cleanup',
    json,
    {
      exit: 0,
      stdout: [
        ...diagnosticLines,
        removed
          ? `runs cleanup: removed repo lock at ${lockPath}`
          : `runs cleanup: nothing to remove at ${lockPath}`,
      ],
      stderr: [],
    },
    {
      lockPath,
      cleared: removed,
      ...(meta ? { previousHolder: meta, wasStale: stale } : {}),
    },
  );
}

// `statePath` is re-exported for convenience to keep CLI imports tidy.
export { statePath };
