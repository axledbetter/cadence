import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AutopilotRun } from '../../src/core/autopilot/run-lifecycle.ts';
import { readEvents } from '../../src/core/run-state/events.ts';
import type { VerifierProbes } from '../../src/core/autopilot/resume-verifier.ts';

const FULL_SHA = 'a'.repeat(40);
const SHA256 = 'sha256:' + 'a'.repeat(64);

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-e2e-'));
}

function probes(): VerifierProbes {
  return {
    fileExists: () => true,
    fileSha: () => SHA256,
    gitWorktreeList: () => [{ path: '/tmp/wt', branch: 'feature/x' }],
    gitRevParseHead: () => FULL_SHA,
    gitStatusPorcelain: () => '',
    async migrationLogContains() { return { found: true, checksum: SHA256 }; },
    async ghPrView() { return { headRefName: 'feature/x', mergedAt: '2026-01-01T00:00:00Z' }; },
    async ghPrComment() { return { exists: true }; },
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

const PHASE_OUTPUTS = {
  spec:      { path: 'docs/foo.md', sha: SHA256, size: 100 },
  plan:      { path: 'docs/foo-plan.md', sha: SHA256, size: 200 },
  worktree:  { path: '/tmp/wt', branch: 'feature/x', createdAt: '2026-05-27T08:00:00Z' },
  implement: { baseSha: FULL_SHA, headSha: FULL_SHA, commits: [FULL_SHA], cleanAtComplete: true },
  migrate:   { appliedMigrations: [{ id: '20260527_001', checksum: SHA256, appliedAt: '2026-05-27T08:00:01Z' }] },
  validate:  { reportPath: '.claude/validation-report.json', reportSha: SHA256, verdict: 'pass' as const },
  pr:        { number: 1, url: 'https://github.com/x/y/pull/1', headRef: 'feature/x', headShaAtCreate: FULL_SHA },
  codex:     { iterations: 1, commentIds: ['c1'] },
  bugbot:    { rounds: 1, commentIds: ['c2'], fixed: [], dismissed: ['c2'] },
  merge:     { mergedAt: '2026-05-27T09:00:00Z', mergeCommit: FULL_SHA },
};

const PHASES = Object.keys(PHASE_OUTPUTS) as (keyof typeof PHASE_OUTPUTS)[];

describe('end-to-end resume integration', () => {
  it('test 17: simulate kill-after-each-phase + resume; final state matches non-interrupted control', async () => {
    // Control: run all 10 phases without interruption.
    const ctlCwd = tmpCwd();
    const ctlRun = await AutopilotRun.create(baseOpts(ctlCwd));
    for (const p of PHASES) {
      await ctlRun.beginPhase(p, {});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await ctlRun.endPhase(p, PHASE_OUTPUTS[p] as any);
    }
    await ctlRun.release();
    const ctlEvents = readEvents(ctlRun.runDir).events;
    const ctlSuccessCount = ctlEvents.filter(e => e.event === 'phase.success').length;
    assert.equal(ctlSuccessCount, 10);
    fs.rmSync(ctlCwd, { recursive: true, force: true });

    // Killed: kill after each phase, then resume, advance one more phase, kill, resume...
    const cwd = tmpCwd();
    let run = await AutopilotRun.create(baseOpts(cwd));
    const runId = run.runId;
    for (let i = 0; i < PHASES.length; i++) {
      const p = PHASES[i]!;
      await run.beginPhase(p, {});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await run.endPhase(p, PHASE_OUTPUTS[p] as any);
      // Simulate kill: release lock.
      await run.release();

      // Resume.
      const r = await AutopilotRun.resume({ cwd, runId, probes: probes() });
      if (i === PHASES.length - 1) {
        // Last phase done — nextPhase should be null
        assert.equal(r.kind, 'resumable');
        if (r.kind === 'resumable') {
          assert.equal(r.nextPhase, null);
          await r.run.release();
        }
      } else {
        assert.equal(r.kind, 'resumable');
        if (r.kind === 'resumable') {
          assert.equal(r.nextPhase, PHASES[i + 1]);
          run = r.run;
        } else {
          assert.fail(`resume failed at phase ${p}: ${JSON.stringify(r)}`);
        }
      }
    }

    // Final state should have all 10 phaseOutputs.
    const stateRaw = fs.readFileSync(path.join(run.runDir, 'state.json'), 'utf8');
    const state = JSON.parse(stateRaw);
    const outputs = state.config.phaseOutputs;
    assert.equal(Object.keys(outputs).length, 10);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
