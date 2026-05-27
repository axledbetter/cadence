import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AutopilotRun,
  STALE_LOCK_TIMEOUT_MS,
} from '../../src/core/autopilot/run-lifecycle.ts';
import { readEvents } from '../../src/core/run-state/events.ts';
import { readStateSnapshot } from '../../src/core/run-state/state.ts';
import type { VerifierProbes } from '../../src/core/autopilot/resume-verifier.ts';

const FULL_SHA = 'a'.repeat(40);
const SHA256 = 'sha256:' + 'a'.repeat(64);

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-lifecycle-'));
}

function makeStubProbes(overrides: Partial<VerifierProbes> = {}): VerifierProbes {
  return {
    fileExists: () => true,
    fileSha: () => SHA256,
    gitWorktreeList: () => [],
    gitRevParseHead: () => FULL_SHA,
    gitStatusPorcelain: () => '',
    async migrationLogContains() { return { found: false }; },
    async ghPrView() { return { headRefName: 'feature/x', mergedAt: null }; },
    async ghPrComment() { return { exists: true }; },
    ...overrides,
  };
}

function baseCreateOpts(cwd: string): Parameters<typeof AutopilotRun.create>[0] {
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

describe('AutopilotRun.create', () => {
  it('test 1: state.json + lock exist, currentPhase is spec, status active, cadenceVersion set', async () => {
    const cwd = tmpCwd();
    const run = await AutopilotRun.create(baseCreateOpts(cwd));
    try {
      assert.ok(fs.existsSync(path.join(run.runDir, 'state.json')));
      assert.ok(fs.existsSync(path.join(run.runDir, '.lock-meta.json')));
      assert.equal(run.currentPhase, 'spec');
      const state = readStateSnapshot(run.runDir);
      assert.ok(state);
      assert.equal((state!.config as { cadenceVersion?: string }).cadenceVersion, '8.5.0');
      assert.equal((state!.config as { createdByCommand?: string }).createdByCommand, 'autopilot');
    } finally {
      await run.release();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('refuses when env flag is off and __forceEnable not set', async () => {
    const cwd = tmpCwd();
    const opts = { ...baseCreateOpts(cwd) };
    delete (opts as { __forceEnable?: boolean }).__forceEnable;
    const oldEnv = process.env.CADENCE_RUN_STATE_ENABLED;
    delete process.env.CADENCE_RUN_STATE_ENABLED;
    try {
      await assert.rejects(() => AutopilotRun.create(opts), /CADENCE_RUN_STATE_ENABLED/);
    } finally {
      if (oldEnv !== undefined) process.env.CADENCE_RUN_STATE_ENABLED = oldEnv;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('AutopilotRun lifecycle (happy path)', () => {
  it('test 2: end-to-end 9 phase-complete events, lock released, all phaseOutputs populated', async () => {
    const cwd = tmpCwd();
    const run = await AutopilotRun.create(baseCreateOpts(cwd));
    try {
      // spec, plan, validate (idempotent file-evidence phases)
      await run.beginPhase('spec', {});
      await run.endPhase('spec', { path: 'docs/foo.md', sha: SHA256, size: 100 });
      await run.beginPhase('plan', {});
      await run.endPhase('plan', { path: 'docs/foo-plan.md', sha: SHA256, size: 200 });
      await run.beginPhase('worktree', {});
      await run.endPhase('worktree', { path: '/tmp/wt', branch: 'feature/x', createdAt: new Date().toISOString() });
      await run.beginPhase('implement', {});
      await run.endPhase('implement', { baseSha: FULL_SHA, headSha: FULL_SHA, commits: [FULL_SHA], cleanAtComplete: true });
      await run.beginPhase('migrate', {});
      await run.endPhase('migrate', { appliedMigrations: [] });
      await run.beginPhase('validate', {});
      await run.endPhase('validate', { reportPath: '.claude/validation-report.json', reportSha: SHA256, verdict: 'pass' });
      await run.beginPhase('pr', {});
      await run.endPhase('pr', { number: 1, url: 'https://github.com/x/y/pull/1', headRef: 'feature/x', headShaAtCreate: FULL_SHA });
      await run.beginPhase('codex', {});
      await run.endPhase('codex', { iterations: 1, commentIds: ['c1'] });
      await run.beginPhase('bugbot', {});
      await run.endPhase('bugbot', { rounds: 1, commentIds: ['c2'], fixed: [], dismissed: ['c2'] });
      await run.beginPhase('merge', {});
      await run.endPhase('merge', { mergedAt: new Date().toISOString(), mergeCommit: FULL_SHA });

      const { events } = readEvents(run.runDir);
      const successes = events.filter(e => e.event === 'phase.success');
      assert.equal(successes.length, 10);

      const state = readStateSnapshot(run.runDir)!;
      const outputs = (state.config as { phaseOutputs: Record<string, unknown> }).phaseOutputs;
      assert.ok(outputs.spec);
      assert.ok(outputs.plan);
      assert.ok(outputs.worktree);
      assert.ok(outputs.implement);
      assert.ok(outputs.migrate);
      assert.ok(outputs.validate);
      assert.ok(outputs.pr);
      assert.ok(outputs.codex);
      assert.ok(outputs.bugbot);
      assert.ok(outputs.merge);
    } finally {
      await run.release();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('AutopilotRun.resume', () => {
  it('test 3: SIGKILL after implement start → resume → must re-run (no success recorded)', async () => {
    const cwd = tmpCwd();
    const run = await AutopilotRun.create(baseCreateOpts(cwd));
    const runId = run.runId;
    await run.beginPhase('spec', {});
    await run.endPhase('spec', { path: 'docs/foo.md', sha: SHA256, size: 100 });
    await run.beginPhase('plan', {});
    await run.endPhase('plan', { path: 'docs/foo-plan.md', sha: SHA256, size: 200 });
    await run.beginPhase('worktree', {});
    await run.endPhase('worktree', { path: '/tmp/wt', branch: 'feature/x', createdAt: new Date().toISOString() });
    await run.beginPhase('implement', {});
    // No endPhase — emulate SIGKILL mid-implement.
    await run.release();

    const probes = makeStubProbes({
      gitWorktreeList: () => [{ path: '/tmp/wt', branch: 'feature/x' }],
    });
    const resumed = await AutopilotRun.resume({ cwd, runId, probes });
    assert.equal(resumed.kind, 'resumable');
    if (resumed.kind === 'resumable') {
      assert.equal(resumed.nextPhase, 'implement');
      await resumed.run.release();
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('test 4: resume after implement complete → skip-already-applied, advances to migrate', async () => {
    const cwd = tmpCwd();
    const run = await AutopilotRun.create(baseCreateOpts(cwd));
    const runId = run.runId;
    await run.beginPhase('spec', {});
    await run.endPhase('spec', { path: 'docs/foo.md', sha: SHA256, size: 100 });
    await run.beginPhase('plan', {});
    await run.endPhase('plan', { path: 'docs/foo-plan.md', sha: SHA256, size: 200 });
    await run.beginPhase('worktree', {});
    await run.endPhase('worktree', { path: '/tmp/wt', branch: 'feature/x', createdAt: new Date().toISOString() });
    await run.beginPhase('implement', {});
    await run.endPhase('implement', { baseSha: FULL_SHA, headSha: FULL_SHA, commits: [FULL_SHA], cleanAtComplete: true });
    await run.release();

    const probes = makeStubProbes({
      gitWorktreeList: () => [{ path: '/tmp/wt', branch: 'feature/x' }],
    });
    const resumed = await AutopilotRun.resume({ cwd, runId, probes });
    assert.equal(resumed.kind, 'resumable');
    if (resumed.kind === 'resumable') {
      assert.equal(resumed.nextPhase, 'migrate');
      // All 4 prior phases verified
      const applied = resumed.verifications.filter(v => v.kind === 'verified-applied');
      assert.equal(applied.length, 4);
      await resumed.run.release();
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('test 5: worktree HEAD divergence → needs-human', async () => {
    const cwd = tmpCwd();
    const run = await AutopilotRun.create(baseCreateOpts(cwd));
    const runId = run.runId;
    await run.beginPhase('spec', {});
    await run.endPhase('spec', { path: 'docs/foo.md', sha: SHA256, size: 100 });
    await run.beginPhase('plan', {});
    await run.endPhase('plan', { path: 'docs/foo-plan.md', sha: SHA256, size: 200 });
    await run.beginPhase('worktree', {});
    await run.endPhase('worktree', { path: '/tmp/wt', branch: 'feature/x', createdAt: new Date().toISOString() });
    await run.beginPhase('implement', {});
    await run.endPhase('implement', { baseSha: FULL_SHA, headSha: FULL_SHA, commits: [FULL_SHA], cleanAtComplete: true });
    await run.release();

    // Simulate divergence: HEAD is now a different SHA
    const probes = makeStubProbes({
      gitWorktreeList: () => [{ path: '/tmp/wt', branch: 'feature/x' }],
      gitRevParseHead: () => 'b'.repeat(40),
    });
    const resumed = await AutopilotRun.resume({ cwd, runId, probes });
    assert.equal(resumed.kind, 'needs-human');
    if (resumed.kind === 'needs-human') {
      assert.equal(resumed.offendingPhase, 'implement');
      assert.match(resumed.reason, /HEAD diverged/);
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('test 6: dirty worktree at resume → needs-human', async () => {
    const cwd = tmpCwd();
    const run = await AutopilotRun.create(baseCreateOpts(cwd));
    const runId = run.runId;
    await run.beginPhase('spec', {});
    await run.endPhase('spec', { path: 'docs/foo.md', sha: SHA256, size: 100 });
    await run.beginPhase('plan', {});
    await run.endPhase('plan', { path: 'docs/foo-plan.md', sha: SHA256, size: 200 });
    await run.beginPhase('worktree', {});
    await run.endPhase('worktree', { path: '/tmp/wt', branch: 'feature/x', createdAt: new Date().toISOString() });
    await run.beginPhase('implement', {});
    await run.endPhase('implement', { baseSha: FULL_SHA, headSha: FULL_SHA, commits: [FULL_SHA], cleanAtComplete: true });
    await run.release();

    const probes = makeStubProbes({
      gitWorktreeList: () => [{ path: '/tmp/wt', branch: 'feature/x' }],
      gitStatusPorcelain: () => '1 .M N... 100644 100644 100644 abc abc src/foo.ts',
    });
    const resumed = await AutopilotRun.resume({ cwd, runId, probes });
    assert.equal(resumed.kind, 'needs-human');
    if (resumed.kind === 'needs-human') {
      assert.match(resumed.reason, /dirty/);
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('test 7: concurrent resume blocked by lock; lock holder PID printed', async () => {
    const cwd = tmpCwd();
    const run = await AutopilotRun.create(baseCreateOpts(cwd));
    const runId = run.runId;
    // First resume should fail with lock-held while run is still active.
    const probes = makeStubProbes();
    const r = await AutopilotRun.resume({ cwd, runId, probes });
    assert.equal(r.kind, 'refused');
    if (r.kind === 'refused') {
      assert.equal(r.reason, 'lock-held');
      assert.ok(r.details.owner);
    }
    await run.release();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('test 8: stale lock with dead PID + heartbeat > timeout — resume succeeds (proper-lockfile stale handling)', async () => {
    const cwd = tmpCwd();
    const run = await AutopilotRun.create(baseCreateOpts(cwd));
    const runId = run.runId;
    const runDir = run.runDir;
    await run.release();

    // Manually set heartbeat to ancient.
    const ancientTime = Date.now() - STALE_LOCK_TIMEOUT_MS * 2;
    fs.writeFileSync(
      path.join(runDir, '.lock-heartbeat.json'),
      JSON.stringify({ lastHeartbeatAt: ancientTime }),
    );
    // Tamper meta to a dead PID.
    const metaPath = path.join(runDir, '.lock-meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      meta.writerId.pid = 99999999; // very high pid, unlikely to exist
      fs.writeFileSync(metaPath, JSON.stringify(meta));
    }

    const probes = makeStubProbes();
    const r = await AutopilotRun.resume({ cwd, runId, probes });
    // Stale lock with dead PID — should be able to resume.
    assert.notEqual(r.kind, 'refused');
    if (r.kind === 'resumable') await r.run.release();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('refuses resume when state had flag off', async () => {
    const cwd = tmpCwd();
    const run = await AutopilotRun.create({
      ...baseCreateOpts(cwd),
      featureFlags: {}, // No CADENCE_RUN_STATE_ENABLED — overridden in create()
    });
    const runId = run.runId;
    await run.release();

    // Manually flip the flag in state.json to simulate a legacy run.
    const statePath = path.join(run.runDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.config.featureFlags = { CADENCE_RUN_STATE_ENABLED: false };
    fs.writeFileSync(statePath, JSON.stringify(state));

    const probes = makeStubProbes();
    const r = await AutopilotRun.resume({ cwd, runId, probes });
    assert.equal(r.kind, 'refused');
    if (r.kind === 'refused') assert.equal(r.reason, 'flag-was-off');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('refuses resume on major version mismatch', async () => {
    const cwd = tmpCwd();
    const run = await AutopilotRun.create(baseCreateOpts(cwd));
    const runId = run.runId;
    await run.release();

    // Tamper cadenceVersion to ancient major.
    const statePath = path.join(run.runDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.config.cadenceVersion = '1.0.0';
    fs.writeFileSync(statePath, JSON.stringify(state));

    const probes = makeStubProbes();
    const r = await AutopilotRun.resume({ cwd, runId, probes });
    assert.equal(r.kind, 'refused');
    if (r.kind === 'refused') assert.equal(r.reason, 'schema-major-mismatch');
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
