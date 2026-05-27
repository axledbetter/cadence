import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyPhaseEvidence,
  type VerifierProbes,
} from '../../src/core/autopilot/resume-verifier.ts';

const FULL_SHA = 'a'.repeat(40);
const SHA256 = 'sha256:' + 'a'.repeat(64);

function makeProbes(o: Partial<VerifierProbes> = {}): VerifierProbes {
  return {
    fileExists: () => true,
    fileSha: () => SHA256,
    gitWorktreeList: () => [],
    gitRevParseHead: () => FULL_SHA,
    gitStatusPorcelain: () => '',
    async migrationLogContains() { return { found: false }; },
    async ghPrView() { return { headRefName: 'feature/x', mergedAt: null }; },
    async ghPrComment() { return { exists: true }; },
    ...o,
  };
}

describe('resume-verifier — migration safety', () => {
  it('completed migrate phase with applied migrations routes to needs-human until log table exists', async () => {
    const res = await verifyPhaseEvidence(
      'migrate',
      { appliedMigrations: [{ id: '20260101', checksum: SHA256, appliedAt: new Date().toISOString() }] },
      { repoRoot: '/tmp', probes: makeProbes() },
    );
    assert.equal(res.kind, 'needs-human');
    if (res.kind === 'needs-human') {
      assert.match(res.reason, /migration verification not yet available/);
    }
  });

  it('empty migrate output is verified-applied', async () => {
    const res = await verifyPhaseEvidence(
      'migrate',
      { appliedMigrations: [] },
      { repoRoot: '/tmp', probes: makeProbes() },
    );
    assert.equal(res.kind, 'verified-applied');
  });

  it('migration with verified log + matching checksum is verified-applied', async () => {
    const res = await verifyPhaseEvidence(
      'migrate',
      { appliedMigrations: [{ id: 'x', checksum: SHA256, appliedAt: new Date().toISOString() }] },
      {
        repoRoot: '/tmp',
        probes: makeProbes({
          async migrationLogContains() { return { found: true, checksum: SHA256 }; },
        }),
      },
    );
    assert.equal(res.kind, 'verified-applied');
  });

  it('migration checksum mismatch → needs-human', async () => {
    const res = await verifyPhaseEvidence(
      'migrate',
      { appliedMigrations: [{ id: 'x', checksum: SHA256, appliedAt: new Date().toISOString() }] },
      {
        repoRoot: '/tmp',
        probes: makeProbes({
          async migrationLogContains() { return { found: true, checksum: 'sha256:' + 'b'.repeat(64) }; },
        }),
      },
    );
    assert.equal(res.kind, 'needs-human');
    if (res.kind === 'needs-human') assert.match(res.reason, /checksum mismatch/);
  });
});

describe('resume-verifier — codex/bugbot comment verification (codex NOTE #9)', () => {
  it('all comments exist → verified-applied', async () => {
    const res = await verifyPhaseEvidence(
      'codex',
      { iterations: 1, commentIds: ['c1', 'c2'] },
      {
        repoRoot: '/tmp',
        prNumber: 42,
        probes: makeProbes({ async ghPrComment() { return { exists: true }; } }),
      },
    );
    assert.equal(res.kind, 'verified-applied');
  });

  it('any missing comment → needs-human (never auto-rerun)', async () => {
    let calls = 0;
    const res = await verifyPhaseEvidence(
      'codex',
      { iterations: 1, commentIds: ['c1', 'c2'] },
      {
        repoRoot: '/tmp',
        prNumber: 42,
        probes: makeProbes({
          async ghPrComment() { calls++; return { exists: calls === 1 }; },
        }),
      },
    );
    assert.equal(res.kind, 'needs-human');
    if (res.kind === 'needs-human') assert.match(res.reason, /no longer exist/);
  });

  it('no PR number context → needs-human', async () => {
    const res = await verifyPhaseEvidence(
      'codex',
      { iterations: 1, commentIds: ['c1'] },
      { repoRoot: '/tmp', probes: makeProbes() },
    );
    assert.equal(res.kind, 'needs-human');
  });
});

describe('resume-verifier — pr/merge verification', () => {
  it('pr verified when headRef matches', async () => {
    const res = await verifyPhaseEvidence(
      'pr',
      { number: 42, url: 'https://github.com/x/y/pull/42', headRef: 'feature/x', headShaAtCreate: FULL_SHA },
      {
        repoRoot: '/tmp',
        probes: makeProbes({ async ghPrView() { return { headRefName: 'feature/x', mergedAt: null }; } }),
      },
    );
    assert.equal(res.kind, 'verified-applied');
  });

  it('pr headRef mismatch → needs-human', async () => {
    const res = await verifyPhaseEvidence(
      'pr',
      { number: 42, url: 'https://github.com/x/y/pull/42', headRef: 'feature/x', headShaAtCreate: FULL_SHA },
      {
        repoRoot: '/tmp',
        probes: makeProbes({ async ghPrView() { return { headRefName: 'feature/other', mergedAt: null }; } }),
      },
    );
    assert.equal(res.kind, 'needs-human');
  });

  it('merge requires prior PR number', async () => {
    const res = await verifyPhaseEvidence(
      'merge',
      { mergedAt: new Date().toISOString(), mergeCommit: FULL_SHA },
      { repoRoot: '/tmp', probes: makeProbes() },
    );
    assert.equal(res.kind, 'needs-human');
  });

  it('merge verified when PR is merged on GitHub', async () => {
    const res = await verifyPhaseEvidence(
      'merge',
      { mergedAt: new Date().toISOString(), mergeCommit: FULL_SHA },
      {
        repoRoot: '/tmp',
        prNumber: 42,
        probes: makeProbes({ async ghPrView() { return { headRefName: 'x', mergedAt: '2026-01-01T00:00:00Z' }; } }),
      },
    );
    assert.equal(res.kind, 'verified-applied');
  });
});

describe('resume-verifier — validate (re-runnable)', () => {
  it('failed validate triggers must-rerun', async () => {
    const res = await verifyPhaseEvidence(
      'validate',
      { reportPath: 'r.json', reportSha: SHA256, verdict: 'fail' },
      { repoRoot: '/tmp', probes: makeProbes() },
    );
    assert.equal(res.kind, 'must-rerun');
  });

  it('missing report file triggers must-rerun', async () => {
    const res = await verifyPhaseEvidence(
      'validate',
      { reportPath: 'r.json', reportSha: SHA256, verdict: 'pass' },
      { repoRoot: '/tmp', probes: makeProbes({ fileExists: () => false }) },
    );
    assert.equal(res.kind, 'must-rerun');
  });
});
