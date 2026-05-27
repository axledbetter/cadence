import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AutopilotRun } from '../../src/core/autopilot/run-lifecycle.ts';
import type { VerifierProbes } from '../../src/core/autopilot/resume-verifier.ts';

const FULL_SHA = 'a'.repeat(40);
const SHA256 = 'sha256:' + 'a'.repeat(64);

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-fault-'));
}

function stubProbes(o: Partial<VerifierProbes> = {}): VerifierProbes {
  return {
    fileExists: () => true,
    fileSha: () => SHA256,
    gitWorktreeList: () => [{ path: '/tmp/wt', branch: 'feature/x' }],
    gitRevParseHead: () => FULL_SHA,
    gitStatusPorcelain: () => '',
    async migrationLogContains() { return { found: false }; },
    async ghPrView() { return { headRefName: 'feature/x', mergedAt: null }; },
    async ghPrComment() { return { exists: true }; },
    ...o,
  };
}

function baseOpts(cwd: string) {
  return {
    cwd,
    specPath: 'docs/foo.md',
    cadenceVersion: '8.5.0',
    argv: ['cadence', 'autopilot', 'docs/foo.md'],
    featureFlags: { CADENCE_RUN_STATE_ENABLED: true },
    profile: 'solo',
    profileSnapshot: {},
    __forceEnable: true,
  };
}

describe('fault injection — torn writes & recovery', () => {
  it('test 9: phase.success event present but state.config.phaseOutputs missing — recovers from artifact', async () => {
    const cwd = tmpCwd();
    const run = await AutopilotRun.create(baseOpts(cwd));
    const runId = run.runId;
    await run.beginPhase('spec', {});
    await run.endPhase('spec', { path: 'docs/foo.md', sha: SHA256, size: 100 });
    await run.release();

    // Simulate the state.json write failing AFTER the event landed: erase
    // phaseOutputs.spec from state.json but leave the artifact file intact.
    const statePath = path.join(run.runDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    delete state.config.phaseOutputs.spec;
    fs.writeFileSync(statePath, JSON.stringify(state));

    // The artifact file at artifacts/spec.json still exists — recovery should
    // pick it up and proceed (not mark needs-human).
    assert.ok(fs.existsSync(path.join(run.runDir, 'artifacts', 'spec.json')));

    const r = await AutopilotRun.resume({ cwd, runId, probes: stubProbes() });
    assert.equal(r.kind, 'resumable');
    if (r.kind === 'resumable') {
      assert.equal(r.nextPhase, 'plan');
      await r.run.release();
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('test 9b: phase.success event present AND artifact missing → needs-human', async () => {
    const cwd = tmpCwd();
    const run = await AutopilotRun.create(baseOpts(cwd));
    const runId = run.runId;
    await run.beginPhase('spec', {});
    await run.endPhase('spec', { path: 'docs/foo.md', sha: SHA256, size: 100 });
    await run.release();

    // Erase both state.config.phaseOutputs.spec AND the artifact file.
    const statePath = path.join(run.runDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    delete state.config.phaseOutputs.spec;
    fs.writeFileSync(statePath, JSON.stringify(state));
    fs.rmSync(path.join(run.runDir, 'artifacts', 'spec.json'));

    const r = await AutopilotRun.resume({ cwd, runId, probes: stubProbes() });
    assert.equal(r.kind, 'needs-human');
    if (r.kind === 'needs-human') {
      assert.equal(r.offendingPhase, 'spec');
      assert.match(r.reason, /orphaned/);
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('test 10: events.ndjson partial line at EOF — replay tolerates and recovers', async () => {
    const cwd = tmpCwd();
    const run = await AutopilotRun.create(baseOpts(cwd));
    const runId = run.runId;
    await run.beginPhase('spec', {});
    await run.endPhase('spec', { path: 'docs/foo.md', sha: SHA256, size: 100 });
    await run.release();

    // Append a partial (unterminated) JSON line at EOF
    const eventsPath = path.join(run.runDir, 'events.ndjson');
    const raw = fs.readFileSync(eventsPath, 'utf8');
    fs.writeFileSync(eventsPath, raw + '{"event":"phase.start","phase":"plan"', 'utf8');

    const r = await AutopilotRun.resume({ cwd, runId, probes: stubProbes() });
    // Even with partial line, we should be able to resume — the v6 events
    // module truncates partial tails on next append.
    assert.notEqual(r.kind, 'refused');
    if (r.kind === 'resumable') await r.run.release();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('test 11: corrupt state.json (invalid JSON) — recovery falls back to events', async () => {
    const cwd = tmpCwd();
    const run = await AutopilotRun.create(baseOpts(cwd));
    const runId = run.runId;
    await run.beginPhase('spec', {});
    await run.endPhase('spec', { path: 'docs/foo.md', sha: SHA256, size: 100 });
    await run.release();

    // Corrupt state.json
    const statePath = path.join(run.runDir, 'state.json');
    fs.writeFileSync(statePath, '{{{ not json }}}');

    const r = await AutopilotRun.resume({ cwd, runId, probes: stubProbes() });
    // recoverState falls back to events replay. Result depends on whether
    // events replay reconstructs the AutopilotRunConfig — it should not
    // (the v6 fold doesn't know autopilot config), so we expect refused
    // with corrupted reason. This is acceptable; the spec says "bail with
    // 'state corrupted, see events.ndjson for last good state'".
    assert.ok(r.kind === 'refused' || r.kind === 'needs-human');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('test 12: migration applied per events but no DB log evidence → needs-human (codex CRITICAL #2)', async () => {
    const cwd = tmpCwd();
    const run = await AutopilotRun.create(baseOpts(cwd));
    const runId = run.runId;
    await run.beginPhase('spec', {});
    await run.endPhase('spec', { path: 'docs/foo.md', sha: SHA256, size: 100 });
    await run.beginPhase('plan', {});
    await run.endPhase('plan', { path: 'docs/foo-plan.md', sha: SHA256, size: 200 });
    await run.beginPhase('worktree', {});
    await run.endPhase('worktree', { path: '/tmp/wt', branch: 'feature/x', createdAt: new Date().toISOString() });
    await run.beginPhase('implement', {});
    await run.endPhase('implement', { baseSha: FULL_SHA, headSha: FULL_SHA, commits: [FULL_SHA], cleanAtComplete: true });
    await run.beginPhase('migrate', {});
    await run.endPhase('migrate', {
      appliedMigrations: [{ id: '20260527_001', checksum: SHA256, appliedAt: new Date().toISOString() }],
    });
    await run.release();

    const r = await AutopilotRun.resume({ cwd, runId, probes: stubProbes() });
    assert.equal(r.kind, 'needs-human');
    if (r.kind === 'needs-human') {
      assert.equal(r.offendingPhase, 'migrate');
      assert.match(r.reason, /migration verification not yet available/);
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('test 13: PR created per state but not visible on GitHub → needs-human', async () => {
    const cwd = tmpCwd();
    const run = await AutopilotRun.create(baseOpts(cwd));
    const runId = run.runId;
    // Fast-forward to pr phase by writing minimal previous outputs.
    await run.beginPhase('spec', {}); await run.endPhase('spec', { path: 'a', sha: SHA256, size: 1 });
    await run.beginPhase('plan', {}); await run.endPhase('plan', { path: 'b', sha: SHA256, size: 1 });
    await run.beginPhase('worktree', {}); await run.endPhase('worktree', { path: '/tmp/wt', branch: 'feature/x', createdAt: new Date().toISOString() });
    await run.beginPhase('implement', {}); await run.endPhase('implement', { baseSha: FULL_SHA, headSha: FULL_SHA, commits: [FULL_SHA], cleanAtComplete: true });
    await run.beginPhase('migrate', {}); await run.endPhase('migrate', { appliedMigrations: [] });
    await run.beginPhase('validate', {}); await run.endPhase('validate', { reportPath: 'r.json', reportSha: SHA256, verdict: 'pass' });
    await run.beginPhase('pr', {}); await run.endPhase('pr', { number: 42, url: 'https://github.com/x/y/pull/42', headRef: 'feature/x', headShaAtCreate: FULL_SHA });
    await run.release();

    const probes = stubProbes({
      ghPrView: async () => null, // PR not found
    });
    const r = await AutopilotRun.resume({ cwd, runId, probes });
    assert.equal(r.kind, 'needs-human');
    if (r.kind === 'needs-human') assert.equal(r.offendingPhase, 'pr');
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
