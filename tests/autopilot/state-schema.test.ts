import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePhaseOutput,
  validateAutopilotRunConfig,
  isMajorCompatible,
  parseCadenceVersion,
  sha256OfBuffer,
} from '../../src/core/autopilot/run-state-schema.ts';

const FULL_SHA = 'a'.repeat(40);
const SHA256 = 'sha256:' + 'a'.repeat(64);

describe('validatePhaseOutput', () => {
  it('test 14: all required fields present on fresh state', () => {
    // spec
    const r1 = validatePhaseOutput('spec', { path: 'docs/foo.md', sha: SHA256, size: 1024 });
    assert.equal(r1.ok, true);

    // worktree
    const r2 = validatePhaseOutput('worktree', {
      path: '/tmp/wt', branch: 'feature/x', createdAt: new Date().toISOString(),
    });
    assert.equal(r2.ok, true);

    // implement
    const r3 = validatePhaseOutput('implement', {
      baseSha: FULL_SHA, headSha: FULL_SHA, commits: [FULL_SHA], cleanAtComplete: true,
    });
    assert.equal(r3.ok, true);

    // pr
    const r4 = validatePhaseOutput('pr', {
      number: 230, url: 'https://github.com/x/y/pull/230', headRef: 'feature/x', headShaAtCreate: FULL_SHA,
    });
    assert.equal(r4.ok, true);

    // codex
    const r5 = validatePhaseOutput('codex', { iterations: 1, commentIds: ['c1'] });
    assert.equal(r5.ok, true);

    // bugbot
    const r6 = validatePhaseOutput('bugbot', { rounds: 2, commentIds: ['c1', 'c2'], fixed: ['c1'], dismissed: ['c2'] });
    assert.equal(r6.ok, true);

    // migrate (empty list is valid — represents "no migrations to apply")
    const r7 = validatePhaseOutput('migrate', { appliedMigrations: [] });
    assert.equal(r7.ok, true);

    // validate
    const r8 = validatePhaseOutput('validate', {
      reportPath: '.claude/validation-report.json', reportSha: SHA256, verdict: 'pass',
    });
    assert.equal(r8.ok, true);

    // merge
    const r9 = validatePhaseOutput('merge', { mergedAt: new Date().toISOString(), mergeCommit: FULL_SHA });
    assert.equal(r9.ok, true);
  });

  it('rejects malformed payloads with specific errors', () => {
    const r1 = validatePhaseOutput('spec', { path: '', sha: SHA256, size: 1 });
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.match(r1.error, /path/);

    const r2 = validatePhaseOutput('spec', { path: 'x', sha: 'not-a-sha', size: 1 });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.match(r2.error, /sha/);

    const r3 = validatePhaseOutput('implement', {
      baseSha: 'short', headSha: FULL_SHA, commits: [FULL_SHA], cleanAtComplete: true,
    });
    assert.equal(r3.ok, false);

    const r4 = validatePhaseOutput('pr', {
      number: 0, url: 'https://x.test/y', headRef: 'x', headShaAtCreate: FULL_SHA,
    });
    assert.equal(r4.ok, false);

    const r5 = validatePhaseOutput('pr', {
      number: 1, url: 'not-a-url', headRef: 'x', headShaAtCreate: FULL_SHA,
    });
    assert.equal(r5.ok, false);
  });

  it('test 15: round-trip JSON via validateAutopilotRunConfig', () => {
    const cfg = {
      cadenceVersion: '8.5.0',
      argv: ['cadence', 'autopilot', 'spec.md'],
      createdByCommand: 'autopilot' as const,
      featureFlags: { CADENCE_RUN_STATE_ENABLED: true },
      specPath: 'docs/foo.md',
      repoRoot: '/tmp/repo',
      profile: 'solo',
      profileSnapshot: {},
      phaseOutputs: {},
    };
    const v1 = validateAutopilotRunConfig(cfg);
    assert.equal(v1.ok, true);
    // Round-trip
    const json = JSON.parse(JSON.stringify(cfg));
    const v2 = validateAutopilotRunConfig(json);
    assert.equal(v2.ok, true);
  });
});

describe('isMajorCompatible', () => {
  it('test 16: major version mismatch refuses', () => {
    assert.equal(isMajorCompatible('8.5.0', '8.6.0'), true);
    assert.equal(isMajorCompatible('8.5.0', '8.5.99'), true);
    assert.equal(isMajorCompatible('8.5.0', '9.0.0'), false);
    assert.equal(isMajorCompatible('7.0.0', '8.0.0'), false);
  });

  it('handles version strings with pre-release suffix', () => {
    assert.equal(isMajorCompatible('8.5.0-pre', '8.5.0'), true);
    assert.equal(isMajorCompatible('8.5.0', '9.0.0-rc1'), false);
  });

  it('parseCadenceVersion throws on garbage', () => {
    assert.throws(() => parseCadenceVersion('not-a-version'));
  });
});

describe('sha256OfBuffer', () => {
  it('produces sha256:<64-hex> prefix', () => {
    const out = sha256OfBuffer('hello world');
    assert.match(out, /^sha256:[0-9a-f]{64}$/);
  });
  it('is deterministic for same input', () => {
    assert.equal(sha256OfBuffer('x'), sha256OfBuffer('x'));
  });
});
