// tests/cli/runs.test.ts
//
// v6 Phase 3 — coverage for the runs CLI verbs (list, show, gc, delete,
// resume, doctor). Each verb exposes a pure-data result shape from its
// handler, so we test the handlers directly without spawning subprocesses.
// One end-to-end CLI test (welcome / help) lives next door.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createRun, runDirFor, runsRoot } from '../../src/core/run-state/runs.ts';
import { appendEvent, eventsPath } from '../../src/core/run-state/events.ts';
import { readStateSnapshot, statePath, writeStateSnapshot } from '../../src/core/run-state/state.ts';
import { acquireRunLock } from '../../src/core/run-state/lock.ts';
import { ulid } from '../../src/core/run-state/ulid.ts';
import {
  computeResumeLookup,
  runRunResume,
  runRunsCleanup,
  runRunsDelete,
  runRunsDoctor,
  runRunsGc,
  runRunsList,
  runRunsShow,
} from '../../src/cli/runs.ts';
import {
  acquireRepoLock,
  forceUnlockRepoLock,
} from '../../src/core/run-state/repo-lock.ts';
import { RUN_STATE_SCHEMA_VERSION, type RunState } from '../../src/core/run-state/types.ts';

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rs-cli-'));
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Mark a run terminal so deletes / GC can act on it. We mutate the snapshot
 *  in place (state.status='success' + endedAt). */
function markSuccess(runDir: string, daysAgo = 0): void {
  const sp = statePath(runDir);
  const raw = JSON.parse(fs.readFileSync(sp, 'utf8')) as RunState;
  raw.status = 'success';
  raw.endedAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  raw.startedAt = new Date(Date.now() - (daysAgo + 1) * 86_400_000).toISOString();
  fs.writeFileSync(sp, JSON.stringify(raw, null, 2), 'utf8');
}

/** Build a fully-shaped RunState manually. Keeps tests independent of
 *  createRun ordering when we want a specific phase status configuration. */
function fixtureState(opts: {
  runId?: string;
  status?: RunState['status'];
  phases: Array<{
    name: string;
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'aborted';
    idempotent?: boolean;
    hasSideEffects?: boolean;
    attempts?: number;
    externalRefs?: Array<{
      kind:
        | 'github-pr' | 'github-comment' | 'git-remote-push' | 'deploy'
        | 'migration-version' | 'rollback-target' | 'spec-file' | 'plan-file'
        | 'sarif-artifact' | 'review-comments';
      id: string;
      provider?: string;
    }>;
  }>;
  currentPhaseIdx?: number;
}): RunState {
  return {
    schema_version: RUN_STATE_SCHEMA_VERSION,
    runId: opts.runId ?? ulid(),
    startedAt: new Date().toISOString(),
    status: opts.status ?? 'paused',
    phases: opts.phases.map((p, i) => ({
      schema_version: RUN_STATE_SCHEMA_VERSION,
      name: p.name,
      index: i,
      status: p.status,
      idempotent: !!p.idempotent,
      hasSideEffects: !!p.hasSideEffects,
      costUSD: 0,
      attempts: p.attempts ?? (p.status === 'pending' ? 0 : 1),
      artifacts: [],
      externalRefs: (p.externalRefs ?? []).map(r => ({
        kind: r.kind,
        id: r.id,
        ...(r.provider ? { provider: r.provider } : {}),
        observedAt: '2026-05-04T00:00:00Z',
      })),
    })),
    currentPhaseIdx: opts.currentPhaseIdx ?? 0,
    totalCostUSD: 0,
    lastEventSeq: 0,
    writerId: { pid: 0, hostHash: '' },
    cwd: '',
  };
}

// ============================================================================
// runs list
// ============================================================================

describe('runRunsList', () => {
  it('returns "No runs." when nothing has been recorded', async () => {
    const cwd = tmpCwd();
    const r = await runRunsList({ cwd });
    assert.equal(r.exit, 0);
    assert.equal(r.stdout.length, 1);
    assert.match(r.stdout[0]!, /No runs/);
    cleanup(cwd);
  });

  it('lists newest-first by ULID', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['p'] });
    await new Promise(r => setTimeout(r, 5));
    const b = await createRun({ cwd, phases: ['p'] });
    await new Promise(r => setTimeout(r, 5));
    const c = await createRun({ cwd, phases: ['p'] });
    await a.lock.release();
    await b.lock.release();
    await c.lock.release();

    const r = await runRunsList({ cwd });
    assert.equal(r.exit, 0);
    // Header + separator + 3 rows
    assert.equal(r.stdout.length, 5);
    // First data row (idx 2 after header+sep) starts with the newest runId.
    assert.ok(r.stdout[2]!.startsWith(c.runId));
    assert.ok(r.stdout[4]!.startsWith(a.runId));
    cleanup(cwd);
  });

  it('--json emits a structured envelope with the run array', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['p'] });
    await a.lock.release();
    const r = await runRunsList({ cwd, json: true });
    assert.equal(r.exit, 0);
    assert.equal(r.stdout.length, 1);
    const parsed = JSON.parse(r.stdout[0]!);
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.command, 'runs list');
    assert.equal(parsed.status, 'pass');
    assert.equal(parsed.count, 1);
    assert.equal(parsed.runs[0].runId, a.runId);
    cleanup(cwd);
  });

  it('--status filters out non-matching runs', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['p'] });
    const b = await createRun({ cwd, phases: ['p'] });
    await a.lock.release();
    await b.lock.release();
    // Mark `a` as success so it matches --status=completed.
    markSuccess(a.runDir);
    const r = await runRunsList({ cwd, status: 'completed', json: true });
    assert.equal(r.exit, 0);
    const parsed = JSON.parse(r.stdout[0]!);
    assert.equal(parsed.runs.length, 1);
    assert.equal(parsed.runs[0].runId, a.runId);
    assert.equal(parsed.statusFilter, 'success');
    cleanup(cwd);
  });

  it('--status with an unknown value exits 1 with invalid_config', async () => {
    const cwd = tmpCwd();
    const r = await runRunsList({ cwd, status: 'totally-bogus' });
    assert.equal(r.exit, 1);
    assert.match(r.stderr.join('\n'), /invalid_config/);
    cleanup(cwd);
  });
});

// ============================================================================
// runs show
// ============================================================================

describe('runRunsShow', () => {
  it('renders state.json + checklist for an existing run (text)', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['plan', 'impl'] });
    await a.lock.release();
    const r = await runRunsShow({ runId: a.runId, cwd });
    assert.equal(r.exit, 0);
    const out = r.stdout.join('\n');
    assert.match(out, new RegExp(a.runId));
    assert.match(out, /phases:/);
    assert.match(out, /\bplan\b/);
    assert.match(out, /\bimpl\b/);
    cleanup(cwd);
  });

  it('--events tails the events.ndjson log', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['plan'] });
    // Append a couple more events so the tail is non-trivial.
    appendEvent(a.runDir, {
      event: 'phase.start', phase: 'plan', phaseIdx: 0,
      idempotent: true, hasSideEffects: false, attempt: 1,
    }, { writerId: a.lock.writerId, runId: a.runId });
    appendEvent(a.runDir, {
      event: 'phase.success', phase: 'plan', phaseIdx: 0,
      durationMs: 5, artifacts: [],
    }, { writerId: a.lock.writerId, runId: a.runId });
    await a.lock.release();
    const r = await runRunsShow({ runId: a.runId, cwd, events: true, eventsTail: 5 });
    assert.equal(r.exit, 0);
    const out = r.stdout.join('\n');
    assert.match(out, /events \(last \d+\):/);
    assert.match(out, /run\.start/);
    assert.match(out, /phase\.success/);
    cleanup(cwd);
  });

  it('--json bundles state + tail events into the envelope', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['plan'] });
    await a.lock.release();
    const r = await runRunsShow({ runId: a.runId, cwd, json: true });
    assert.equal(r.exit, 0);
    const parsed = JSON.parse(r.stdout[0]!);
    assert.equal(parsed.command, 'runs show');
    assert.equal(parsed.runId, a.runId);
    assert.equal(parsed.state.runId, a.runId);
    assert.ok(Array.isArray(parsed.events));
    cleanup(cwd);
  });

  it('exits 1 not_found for a missing run', async () => {
    const cwd = tmpCwd();
    const phantom = ulid();
    const r = await runRunsShow({ runId: phantom, cwd });
    assert.equal(r.exit, 1);
    assert.match(r.stderr.join('\n'), /not_found/);
    cleanup(cwd);
  });

  it('exits 1 invalid_config for a non-ULID run id', async () => {
    const cwd = tmpCwd();
    const r = await runRunsShow({ runId: 'not-a-ulid', cwd });
    assert.equal(r.exit, 1);
    assert.match(r.stderr.join('\n'), /invalid_config/);
    cleanup(cwd);
  });

  it('falls back to events replay when state.json is missing', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['plan'] });
    await a.lock.release();
    fs.unlinkSync(statePath(a.runDir));
    const r = await runRunsShow({ runId: a.runId, cwd });
    assert.equal(r.exit, 0);
    assert.match(r.stdout.join('\n'), /\(recovered\)/);
    cleanup(cwd);
  });
});

// ============================================================================
// runs gc
// ============================================================================

describe('runRunsGc', () => {
  it('reports nothing-to-delete when no runs are old enough', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['p'] });
    await a.lock.release();
    const r = await runRunsGc({ cwd, olderThanDays: 30, json: true });
    assert.equal(r.exit, 0);
    const parsed = JSON.parse(r.stdout[0]!);
    assert.equal(parsed.deleted.length, 0);
    cleanup(cwd);
  });

  it('--dry-run lists candidates without touching disk', async () => {
    const cwd = tmpCwd();
    // Plant an old terminal-success run.
    const ancient = ulid(Date.now() - 90 * 86_400_000);
    const dir = runDirFor(cwd, ancient);
    fs.mkdirSync(dir, { recursive: true });
    const state: RunState = {
      schema_version: RUN_STATE_SCHEMA_VERSION,
      runId: ancient,
      startedAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
      endedAt: new Date(Date.now() - 89 * 86_400_000).toISOString(),
      status: 'success',
      phases: [],
      currentPhaseIdx: 0,
      totalCostUSD: 0,
      lastEventSeq: 0,
      writerId: { pid: 0, hostHash: '' },
      cwd,
    };
    fs.writeFileSync(statePath(dir), JSON.stringify(state), 'utf8');

    const r = await runRunsGc({ cwd, olderThanDays: 30, dryRun: true, json: true });
    assert.equal(r.exit, 0);
    const parsed = JSON.parse(r.stdout[0]!);
    assert.deepEqual(parsed.candidates, [ancient]);
    assert.equal(parsed.deleted.length, 0);
    assert.ok(fs.existsSync(dir));
    cleanup(cwd);
  });

  it('refuses to delete an active (non-terminal) run', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['p'] });
    // Set its start to ages ago without marking terminal.
    const sp = statePath(a.runDir);
    const raw = JSON.parse(fs.readFileSync(sp, 'utf8')) as RunState;
    raw.startedAt = new Date(Date.now() - 90 * 86_400_000).toISOString();
    fs.writeFileSync(sp, JSON.stringify(raw), 'utf8');
    await a.lock.release();
    const r = await runRunsGc({ cwd, olderThanDays: 30, yes: true, json: true });
    const parsed = JSON.parse(r.stdout[0]!);
    assert.equal(parsed.deleted.length, 0);
    assert.ok(fs.existsSync(a.runDir));
    cleanup(cwd);
  });

  it('--json without --yes hard-fails (non-interactive guard)', async () => {
    const cwd = tmpCwd();
    const ancient = ulid(Date.now() - 90 * 86_400_000);
    const dir = runDirFor(cwd, ancient);
    fs.mkdirSync(dir, { recursive: true });
    const state: RunState = {
      schema_version: RUN_STATE_SCHEMA_VERSION,
      runId: ancient,
      startedAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
      endedAt: new Date(Date.now() - 89 * 86_400_000).toISOString(),
      status: 'success',
      phases: [], currentPhaseIdx: 0, totalCostUSD: 0, lastEventSeq: 0,
      writerId: { pid: 0, hostHash: '' }, cwd,
    };
    fs.writeFileSync(statePath(dir), JSON.stringify(state), 'utf8');
    const r = await runRunsGc({ cwd, olderThanDays: 30, json: true });
    assert.equal(r.exit, 1);
    const parsed = JSON.parse(r.stdout[0]!);
    assert.match(parsed.error, /non-interactive/);
    cleanup(cwd);
  });

  it('--yes --json deletes terminal-success old runs', async () => {
    const cwd = tmpCwd();
    const ancient = ulid(Date.now() - 90 * 86_400_000);
    const dir = runDirFor(cwd, ancient);
    fs.mkdirSync(dir, { recursive: true });
    const state: RunState = {
      schema_version: RUN_STATE_SCHEMA_VERSION,
      runId: ancient,
      startedAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
      endedAt: new Date(Date.now() - 89 * 86_400_000).toISOString(),
      status: 'success',
      phases: [], currentPhaseIdx: 0, totalCostUSD: 0, lastEventSeq: 0,
      writerId: { pid: 0, hostHash: '' }, cwd,
    };
    fs.writeFileSync(statePath(dir), JSON.stringify(state), 'utf8');
    const r = await runRunsGc({ cwd, olderThanDays: 30, yes: true, json: true });
    assert.equal(r.exit, 0);
    const parsed = JSON.parse(r.stdout[0]!);
    assert.deepEqual(parsed.deleted, [ancient]);
    assert.equal(fs.existsSync(dir), false);
    cleanup(cwd);
  });
});

// ============================================================================
// runs delete
// ============================================================================

describe('runRunsDelete', () => {
  it('refuses non-terminal status without --force', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['p'] });
    await a.lock.release(); // release lock so the test isn't about lock_held
    const r = await runRunsDelete({ runId: a.runId, cwd });
    assert.equal(r.exit, 1);
    assert.match(r.stderr.join('\n'), /not terminal/);
    assert.ok(fs.existsSync(a.runDir));
    cleanup(cwd);
  });

  it('deletes when status is terminal (success)', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['p'] });
    await a.lock.release();
    markSuccess(a.runDir);
    const r = await runRunsDelete({ runId: a.runId, cwd, json: true });
    assert.equal(r.exit, 0);
    assert.equal(fs.existsSync(a.runDir), false);
    const parsed = JSON.parse(r.stdout[0]!);
    assert.equal(parsed.deleted, true);
    cleanup(cwd);
  });

  it('--force overrides the terminal-status guard', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['p'] });
    await a.lock.release();
    // status=pending — not terminal — but --force removes anyway.
    const r = await runRunsDelete({ runId: a.runId, cwd, force: true });
    assert.equal(r.exit, 0);
    assert.equal(fs.existsSync(a.runDir), false);
    cleanup(cwd);
  });

  it('rejects with lock_held when a writer holds the lock', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['p'] });
    markSuccess(a.runDir);
    // Don't release the lock — runRunsDelete should fail to acquire.
    const r = await runRunsDelete({ runId: a.runId, cwd });
    assert.equal(r.exit, 1);
    assert.match(r.stderr.join('\n'), /lock_held/);
    assert.ok(fs.existsSync(a.runDir));
    await a.lock.release();
    cleanup(cwd);
  });

  it('exits 1 not_found for missing run', async () => {
    const cwd = tmpCwd();
    const phantom = ulid();
    const r = await runRunsDelete({ runId: phantom, cwd });
    assert.equal(r.exit, 1);
    assert.match(r.stderr.join('\n'), /not_found/);
    cleanup(cwd);
  });

  it('rejects non-ULID run ids', async () => {
    const cwd = tmpCwd();
    const r = await runRunsDelete({ runId: 'wat', cwd });
    assert.equal(r.exit, 1);
    assert.match(r.stderr.join('\n'), /invalid_config/);
    cleanup(cwd);
  });
});

// ============================================================================
// run resume (lookup-only)
// ============================================================================

describe('runRunResume + computeResumeLookup', () => {
  it('decision="retry" when there is no prior success', () => {
    const state = fixtureState({
      phases: [
        { name: 'plan', status: 'pending' },
        { name: 'impl', status: 'pending' },
      ],
    });
    const lookup = computeResumeLookup(state);
    assert.equal(lookup.decision, 'retry');
    assert.equal(lookup.nextPhase, 'plan');
  });

  it('decision="retry" when prior attempt failed (not skipped/needs-human)', () => {
    const state = fixtureState({
      phases: [
        { name: 'plan', status: 'failed', attempts: 1 },
        { name: 'impl', status: 'pending' },
      ],
      currentPhaseIdx: 0,
    });
    const lookup = computeResumeLookup(state);
    assert.equal(lookup.decision, 'retry');
    assert.equal(lookup.nextPhase, 'plan');
    // Phase 6 fold-in (Bugbot LOW PR #91): when there were prior attempts
    // but no success, decideReplay distinguishes "post-failure retry" from
    // "first attempt". The user-visible reason must reflect the actual
    // history so `runs resume` doesn't lie about state awareness.
    assert.match(lookup.reason, /previous attempt\(s\) failed/);
    assert.doesNotMatch(lookup.reason, /first attempt/);
  });

  it('decision="retry" reason still says "first attempt" when there really were no prior attempts', () => {
    const state = fixtureState({
      phases: [
        { name: 'plan', status: 'pending', attempts: 0 },
        { name: 'impl', status: 'pending' },
      ],
      currentPhaseIdx: 0,
    });
    const lookup = computeResumeLookup(state);
    assert.equal(lookup.decision, 'retry');
    assert.match(lookup.reason, /first attempt/);
  });

  it('decision="skip-idempotent" when prior success + idempotent target', () => {
    // Keep at least one non-succeeded phase so the run isn't already-complete.
    // Resuming with --from-phase=plan against an idempotent succeeded phase
    // should short-circuit per Phase 2's runPhase rules.
    const state = fixtureState({
      phases: [
        { name: 'plan', status: 'succeeded' },
        { name: 'impl', status: 'pending' },
      ],
    });
    state.phases[0]!.idempotent = true;
    const lookup = computeResumeLookup(state, 'plan');
    assert.equal(lookup.decision, 'skip-idempotent');
    assert.equal(lookup.nextPhase, 'plan');
  });

  it('decision="needs-human" when prior success + side-effects target', () => {
    // Keep a trailing pending phase so the run isn't already-complete.
    // Phase 6 — without externalRefs the decision is "no externalRefs" /
    // needs-human; with refs but no readbacks (CLI lookup mode) the
    // decision is "no live readback" / needs-human. Both surface needs-human;
    // the reason text differs but always mentions needing human review.
    const state = fixtureState({
      phases: [
        { name: 'deploy', status: 'succeeded', hasSideEffects: true },
        { name: 'verify', status: 'pending' },
      ],
    });
    const lookup = computeResumeLookup(state, 'deploy');
    assert.equal(lookup.decision, 'needs-human');
    assert.match(lookup.reason, /human review|human approval/);
  });

  it('decision="already-complete" when every phase succeeded', () => {
    const state = fixtureState({
      status: 'success',
      phases: [
        { name: 'plan', status: 'succeeded' },
        { name: 'impl', status: 'succeeded' },
      ],
    });
    const lookup = computeResumeLookup(state);
    assert.equal(lookup.decision, 'already-complete');
    assert.equal(lookup.nextPhase, null);
  });

  it('decision="already-complete" when --from-phase targets a succeeded phase with idempotent=false AND hasSideEffects=false (Bugbot LOW, PR #88)', () => {
    // Regression: prior code fell through to the generic "no prior success
    // — first attempt" reason and a `retry` decision when the target was
    // succeeded but neither idempotent nor side-effecting (the createRun
    // default). Wrong reason text + potentially unsafe replay decision once
    // execution wires in. Now returns `already-complete` with a reason
    // pointing at --force-replay.
    const state = fixtureState({
      phases: [
        { name: 'plan', status: 'succeeded', idempotent: false, hasSideEffects: false },
        { name: 'impl', status: 'pending' },
      ],
    });
    const lookup = computeResumeLookup(state, 'plan');
    assert.equal(lookup.decision, 'already-complete');
    // Phase 6 — reason now comes from decideReplay's vocabulary; the
    // skip-already-applied-because-no-side-effects case mentions exactly
    // that. Existing CLI consumers see the same `already-complete` decision
    // verb, but the inner reason changed.
    assert.match(lookup.reason, /previously succeeded/);
    assert.match(lookup.reason, /no side effects|skip-already-applied/);
  });

  it('JSON envelope marks lookup-only and includes the v1 schema', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['plan', 'impl'] });
    await a.lock.release();
    const r = await runRunResume({ runId: a.runId, cwd, json: true });
    assert.equal(r.exit, 0);
    const parsed = JSON.parse(r.stdout[0]!);
    assert.equal(parsed.command, 'run resume');
    assert.equal(parsed.lookupOnly, true);
    assert.equal(parsed.schema_version, 1);
    cleanup(cwd);
  });

  it('rejects --from-phase that does not match a phase name', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['plan', 'impl'] });
    await a.lock.release();
    const r = await runRunResume({ runId: a.runId, cwd, fromPhase: 'nonsense' });
    assert.equal(r.exit, 1);
    assert.match(r.stderr.join('\n'), /invalid_config/);
    cleanup(cwd);
  });

  it('exits 1 not_found for a missing run', async () => {
    const cwd = tmpCwd();
    const r = await runRunResume({ runId: ulid(), cwd });
    assert.equal(r.exit, 1);
    assert.match(r.stderr.join('\n'), /not_found/);
    cleanup(cwd);
  });

  // -------------------------------------------------------------------------
  // Phase 6 — decideReplay-backed CLI lookup
  // -------------------------------------------------------------------------

  it('Phase 6: prior success + side-effects + persisted refs (lookup mode) → needs-human (no live readback)', () => {
    const state = fixtureState({
      phases: [
        {
          name: 'pr',
          status: 'succeeded',
          hasSideEffects: true,
          externalRefs: [{ kind: 'github-pr', id: '99', provider: 'github' }],
        },
        { name: 'verify', status: 'pending' },
      ],
    });
    const lookup = computeResumeLookup(state, 'pr');
    assert.equal(lookup.decision, 'needs-human');
    assert.match(lookup.reason, /no live readback|--force-replay/);
    assert.equal(lookup.externalRefs.length, 1);
    assert.equal(lookup.externalRefs[0]?.kind, 'github-pr');
  });

  it('Phase 6: prior success + side-effects + NO refs → needs-human (no externalRefs)', () => {
    const state = fixtureState({
      phases: [
        { name: 'deploy', status: 'succeeded', hasSideEffects: true },
        { name: 'verify', status: 'pending' },
      ],
    });
    const lookup = computeResumeLookup(state, 'deploy');
    assert.equal(lookup.decision, 'needs-human');
    assert.match(lookup.reason, /no externalRefs/);
  });

  it('Phase 6: prior success + idempotent → skip-idempotent (CLI vocabulary preserved)', () => {
    const state = fixtureState({
      phases: [
        { name: 'validate', status: 'succeeded', idempotent: true },
        { name: 'next', status: 'pending' },
      ],
    });
    const lookup = computeResumeLookup(state, 'validate');
    assert.equal(lookup.decision, 'skip-idempotent');
    assert.match(lookup.reason, /idempotent/);
  });

  it('Phase 6: prior success + no side-effects + not idempotent → already-complete (CLI alias for skip-already-applied)', () => {
    const state = fixtureState({
      phases: [
        { name: 'plan', status: 'succeeded' },
        { name: 'impl', status: 'pending' },
      ],
    });
    const lookup = computeResumeLookup(state, 'plan');
    assert.equal(lookup.decision, 'already-complete');
    assert.match(lookup.reason, /no side effects|skip-already-applied/);
  });
});

// ============================================================================
// runs doctor
// ============================================================================

describe('runRunsDoctor', () => {
  it('reports OK when state.json matches the events replay', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['plan'] });
    await a.lock.release();
    const r = await runRunsDoctor({ cwd, json: true });
    assert.equal(r.exit, 0);
    const parsed = JSON.parse(r.stdout[0]!);
    assert.equal(parsed.driftCount, 0);
    assert.equal(parsed.runs[0].drift, 'none');
    cleanup(cwd);
  });

  it('detects snapshot-vs-replay drift and exits non-zero (no --fix)', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['plan'] });
    await a.lock.release();
    // Mutate state.json so it drifts from the events replay (which still
    // shows pending). Set status=success with no matching event.
    const sp = statePath(a.runDir);
    const raw = JSON.parse(fs.readFileSync(sp, 'utf8')) as RunState;
    raw.status = 'success';
    fs.writeFileSync(sp, JSON.stringify(raw), 'utf8');
    const r = await runRunsDoctor({ cwd, json: true });
    assert.equal(r.exit, 1);
    const parsed = JSON.parse(r.stdout[0]!);
    assert.equal(parsed.driftCount, 1);
    assert.equal(parsed.runs[0].drift, 'snapshot-vs-replay');
    cleanup(cwd);
  });

  it('--fix rewrites state.json from events replay', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['plan'] });
    await a.lock.release();
    // Corrupt state.json (unreadable JSON).
    fs.writeFileSync(statePath(a.runDir), 'not json', 'utf8');
    const r = await runRunsDoctor({ cwd, fix: true, json: true });
    assert.equal(r.exit, 0);
    const parsed = JSON.parse(r.stdout[0]!);
    assert.equal(parsed.fixApplied, true);
    assert.equal(parsed.runs[0].fixed, true);
    // After --fix, state.json should be a valid RunState again.
    const fresh = readStateSnapshot(a.runDir);
    assert.ok(fresh, 'state.json should have been rewritten');
    assert.equal(fresh!.runId, a.runId);
    cleanup(cwd);
  });

  it('handles snapshot-missing by rewriting from replay under --fix', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['plan'] });
    await a.lock.release();
    fs.unlinkSync(statePath(a.runDir));
    const r = await runRunsDoctor({ cwd, fix: true, json: true });
    assert.equal(r.exit, 0);
    const parsed = JSON.parse(r.stdout[0]!);
    assert.equal(parsed.runs[0].drift, 'snapshot-missing');
    assert.equal(parsed.runs[0].fixed, true);
    assert.ok(fs.existsSync(statePath(a.runDir)));
    cleanup(cwd);
  });

  it('limits the check to a single run when --run-id is supplied', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['plan'] });
    const b = await createRun({ cwd, phases: ['plan'] });
    await a.lock.release();
    await b.lock.release();
    const r = await runRunsDoctor({ cwd, runId: a.runId, json: true });
    assert.equal(r.exit, 0);
    const parsed = JSON.parse(r.stdout[0]!);
    assert.equal(parsed.runs.length, 1);
    assert.equal(parsed.runs[0].runId, a.runId);
    cleanup(cwd);
  });

  it('handles an empty cache cleanly', async () => {
    const cwd = tmpCwd();
    const r = await runRunsDoctor({ cwd, json: true });
    assert.equal(r.exit, 0);
    const parsed = JSON.parse(r.stdout[0]!);
    assert.deepEqual(parsed.runs, []);
    cleanup(cwd);
  });
});

// ============================================================================
// Lock interaction sanity — covers the delete-vs-active-writer path more
// explicitly. We use acquireRunLock directly (rather than via createRun) so
// the assertion is about the lock_held translation in runRunsDelete and not
// about createRun's lock acquisition timing.
// ============================================================================

describe('runs delete + lock interaction', () => {
  it('still rejects with lock_held when an external writer holds the lock', async () => {
    const cwd = tmpCwd();
    const runId = ulid();
    const dir = runDirFor(cwd, runId);
    fs.mkdirSync(dir, { recursive: true });
    // Seed a terminal state.json so the terminal-status guard would pass.
    const state: RunState = {
      schema_version: RUN_STATE_SCHEMA_VERSION,
      runId,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      status: 'success',
      phases: [], currentPhaseIdx: 0, totalCostUSD: 0, lastEventSeq: 0,
      writerId: { pid: 0, hostHash: '' }, cwd,
    };
    writeStateSnapshot(dir, state);
    // Acquire the lock from a "different" writer.
    const handle = await acquireRunLock(dir);
    try {
      const r = await runRunsDelete({ runId, cwd });
      assert.equal(r.exit, 1);
      assert.match(r.stderr.join('\n'), /lock_held/);
      assert.ok(fs.existsSync(dir));
    } finally {
      await handle.release();
    }
    cleanup(cwd);
  });
});

// ============================================================================
// Smoke: events.ndjson presence is a sanity precondition for show + doctor
// ============================================================================

describe('runs CLI sanity', () => {
  it('createRun + runs show -> events.ndjson exists', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['p'] });
    await a.lock.release();
    assert.ok(fs.existsSync(eventsPath(a.runDir)));
    const r = await runRunsShow({ runId: a.runId, cwd });
    assert.equal(r.exit, 0);
    cleanup(cwd);
  });
});

// ============================================================================
// runs cleanup --force-unlock — v7.11.0 PR 2/6
// ============================================================================

describe('runRunsCleanup --force-unlock', () => {
  /** Default lock path for a given cwd, matching the CLI's resolver. */
  function lockPathFor(cwd: string): string {
    return path.join(cwd, '.claude', 'run-state', 'repo.lock');
  }

  it('rejects without --force-unlock (no other operation defined yet)', async () => {
    const cwd = tmpCwd();
    const r = await runRunsCleanup({ cwd, forceUnlock: false });
    assert.equal(r.exit, 1);
    assert.match(r.stderr.join('\n'), /requires an operation flag/);
    cleanup(cwd);
  });

  it('returns "nothing to do" when no lock is present', async () => {
    const cwd = tmpCwd();
    const r = await runRunsCleanup({
      cwd,
      forceUnlock: true,
      yes: true,
      lockPath: lockPathFor(cwd),
    });
    assert.equal(r.exit, 0);
    assert.match(r.stdout.join('\n'), /nothing to do/);
    cleanup(cwd);
  });

  it('refuses to clear a live (non-stale) lock without --allow-active', async () => {
    // Codex pass 1 WARNING: scripted `--yes` could silently steal an
    // active lock. Default behaviour is now to refuse non-stale locks.
    const cwd = tmpCwd();
    const lockPath = lockPathFor(cwd);
    const handle = await acquireRepoLock({
      lockPath,
      command: 'live-test',
      run_id: 'r1',
    });

    const r = await runRunsCleanup({
      cwd,
      forceUnlock: true,
      yes: true,
      lockPath,
    });
    assert.equal(r.exit, 1);
    assert.match(r.stderr.join('\n'), /not stale|--allow-active/);
    // Lock untouched.
    assert.ok(fs.existsSync(lockPath + '.lock'));

    await handle.release();
    cleanup(cwd);
  });

  it('removes a live lock when --allow-active --yes is set', async () => {
    const cwd = tmpCwd();
    const lockPath = lockPathFor(cwd);
    const handle = await acquireRepoLock({
      lockPath,
      command: 'orphan-test',
      run_id: 'r1',
    });
    // Intentionally do NOT release — simulate a crashed process the user
    // is sure is dead.

    const r = await runRunsCleanup({
      cwd,
      forceUnlock: true,
      yes: true,
      allowActive: true,
      lockPath,
    });
    assert.equal(r.exit, 0, r.stderr.join('\n'));
    assert.match(r.stdout.join('\n'), /removed repo lock/);
    assert.equal(fs.existsSync(lockPath + '.lock'), false);
    assert.equal(fs.existsSync(lockPath + '.meta.json'), false);

    // After cleanup, release on the original handle should be no-op safe.
    await handle.release();
    cleanup(cwd);
  });

  it('refuses to clear a no-metadata lock without --allow-active', async () => {
    // Codex pass 1 WARNING: missing metadata could be the narrow window
    // between proper-lockfile acquisition and metadata sidecar write —
    // i.e. a LIVE acquirer. Refuse by default.
    const cwd = tmpCwd();
    const lockPath = lockPathFor(cwd);
    // Create the .lock dir without metadata.
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, '');
    fs.mkdirSync(lockPath + '.lock', { recursive: true });

    const r = await runRunsCleanup({
      cwd,
      forceUnlock: true,
      yes: true,
      lockPath,
    });
    assert.equal(r.exit, 1);
    assert.match(r.stderr.join('\n'), /no metadata|--allow-active/);
    cleanup(cwd);
  });

  it('aborts when promptFn returns anything other than "yes" (stale lock)', async () => {
    const cwd = tmpCwd();
    const lockPath = lockPathFor(cwd);
    const handle = await acquireRepoLock({
      lockPath,
      command: 'orphan-test',
      run_id: 'r1',
    });
    // Forge stale metadata so the safety gate doesn't refuse first.
    const ancient = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      lockPath + '.meta.json',
      JSON.stringify({
        pid: 0x7fffffff,
        hostname: os.hostname(),
        command: 'orphan-test',
        run_id: 'r1',
        acquired_at_iso: ancient,
      }),
    );

    let prompted = false;
    const r = await runRunsCleanup({
      cwd,
      forceUnlock: true,
      lockPath,
      promptFn: async () => {
        prompted = true;
        return 'no';
      },
    });
    assert.equal(prompted, true, 'prompt should have been invoked');
    assert.equal(r.exit, 1);
    assert.match(r.stderr.join('\n'), /aborted/);
    assert.ok(fs.existsSync(lockPath + '.lock'));

    await handle.release();
    forceUnlockRepoLock(lockPath);
    cleanup(cwd);
  });

  it('proceeds when promptFn returns "yes" (with whitespace) on stale lock', async () => {
    const cwd = tmpCwd();
    const lockPath = lockPathFor(cwd);
    const handle = await acquireRepoLock({
      lockPath,
      command: 'orphan-test',
      run_id: 'r1',
    });
    const ancient = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      lockPath + '.meta.json',
      JSON.stringify({
        pid: 0x7fffffff,
        hostname: os.hostname(),
        command: 'orphan-test',
        run_id: 'r1',
        acquired_at_iso: ancient,
      }),
    );

    const r = await runRunsCleanup({
      cwd,
      forceUnlock: true,
      lockPath,
      promptFn: async () => '  yes  \n',
    });
    assert.equal(r.exit, 0, r.stderr.join('\n'));
    assert.equal(fs.existsSync(lockPath + '.lock'), false);

    await handle.release();
    cleanup(cwd);
  });

  it('requires --yes in --json mode for stale lock (no interactive prompt under JSON)', async () => {
    const cwd = tmpCwd();
    const lockPath = lockPathFor(cwd);
    const handle = await acquireRepoLock({
      lockPath,
      command: 'orphan-test',
      run_id: 'r1',
    });
    const ancient = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      lockPath + '.meta.json',
      JSON.stringify({
        pid: 0x7fffffff,
        hostname: os.hostname(),
        command: 'orphan-test',
        run_id: 'r1',
        acquired_at_iso: ancient,
      }),
    );

    const r = await runRunsCleanup({
      cwd,
      forceUnlock: true,
      json: true,
      lockPath,
    });
    assert.equal(r.exit, 1);
    const parsed = JSON.parse(r.stdout[0]!);
    assert.equal(parsed.status, 'fail');
    assert.match(String(parsed.error), /requires --yes/);

    await handle.release();
    forceUnlockRepoLock(lockPath);
    cleanup(cwd);
  });

  it('--json envelope reports cleared=true with previous holder metadata', async () => {
    const cwd = tmpCwd();
    const lockPath = lockPathFor(cwd);
    const handle = await acquireRepoLock({
      lockPath,
      command: 'orphan-test',
      run_id: 'rrr',
    });
    const ancient = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      lockPath + '.meta.json',
      JSON.stringify({
        pid: 0x7fffffff,
        hostname: os.hostname(),
        command: 'orphan-test',
        run_id: 'rrr',
        acquired_at_iso: ancient,
      }),
    );

    const r = await runRunsCleanup({
      cwd,
      forceUnlock: true,
      yes: true,
      json: true,
      lockPath,
    });
    assert.equal(r.exit, 0);
    const parsed = JSON.parse(r.stdout[0]!);
    assert.equal(parsed.status, 'pass');
    assert.equal(parsed.cleared, true);
    assert.equal(parsed.previousHolder.command, 'orphan-test');
    assert.equal(parsed.previousHolder.run_id, 'rrr');

    await handle.release();
    cleanup(cwd);
  });
});
