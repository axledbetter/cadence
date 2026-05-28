import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AutopilotRun } from '../../src/core/autopilot/run-lifecycle.ts';
import type { DiffProvider } from '../../src/core/schema-changes/diff-provider.ts';

const FULL_SHA = 'a'.repeat(40);
const SHA256 = 'sha256:' + 'a'.repeat(64);

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-schema-lifecycle-'));
}

function baseOpts(cwd: string, schemaPaths: string[] = [], diffProvider?: DiffProvider) {
  return {
    cwd,
    specPath: 'docs/foo.md',
    cadenceVersion: '8.6.0',
    argv: ['cadence', 'autopilot', 'docs/foo.md'],
    featureFlags: { CADENCE_RUN_STATE_ENABLED: true },
    profile: 'solo',
    profileSnapshot: { schemaPaths } as Record<string, unknown>,
    __forceEnable: true,
    ...(diffProvider ? { diffProvider } : {}),
  };
}

function fakeDiffProvider(files: { path: string; before?: string; after?: string }[]): DiffProvider {
  return {
    async collectChangedFiles() {
      return files.map((f) => ({
        path: f.path,
        status: f.before === undefined ? 'added' as const : 'modified' as const,
        ...(f.before !== undefined ? { beforeText: f.before } : {}),
        ...(f.after !== undefined ? { afterText: f.after } : {}),
      }));
    },
  };
}

const IMPLEMENT_OUT = {
  baseSha: FULL_SHA,
  headSha: FULL_SHA,
  commits: [FULL_SHA],
  cleanAtComplete: true,
};

describe('lifecycle — schema-change manifest enforcement (codex CRITICAL opt-in gate)', () => {
  it('empty schemaPaths → endPhase accepts any output (back-compat)', async () => {
    const cwd = tmpCwd();
    const run = await AutopilotRun.create(baseOpts(cwd, []));
    await run.beginPhase('spec', {});
    await run.endPhase('spec', { path: 'docs/foo.md', sha: SHA256, size: 1 });
    await run.beginPhase('plan', {});
    await run.endPhase('plan', { path: 'docs/foo-plan.md', sha: SHA256, size: 1 });
    await run.beginPhase('worktree', {});
    await run.endPhase('worktree', { path: '/tmp/wt', branch: 'feature/x', createdAt: '2026-01-01T00:00:00Z' });
    await run.beginPhase('implement', {});
    // Endphase should NOT throw — opt-in gate is off.
    await run.endPhase('implement', IMPLEMENT_OUT);
    await run.release();
  });

  it('opt-in, manifest covers diff → endPhase succeeds', async () => {
    const cwd = tmpCwd();
    const diff = fakeDiffProvider([{ path: 'data/deltas/20260527.sql', after: 'CREATE TABLE foo (id uuid);' }]);
    const run = await AutopilotRun.create(baseOpts(cwd, ['data/deltas/*.sql'], diff));
    await run.beginPhase('spec', {});
    await run.endPhase('spec', { path: 'docs/foo.md', sha: SHA256, size: 1 });
    await run.beginPhase('plan', {});
    await run.endPhase('plan', { path: 'docs/foo-plan.md', sha: SHA256, size: 1 });
    await run.beginPhase('worktree', {});
    await run.endPhase('worktree', { path: '/tmp/wt', branch: 'feature/x', createdAt: '2026-01-01T00:00:00Z' });
    await run.beginPhase('implement', {});
    await run.endPhase('implement', {
      ...IMPLEMENT_OUT,
      schemaChanges: [{
        file: 'data/deltas/20260527.sql',
        kind: 'sql.create_table',
        objectName: 'foo',
        statementIndex: 0,
        additive: true,
        description: 'CREATE TABLE foo',
      }],
    });
    await run.release();
  });

  it('opt-in, manifest missing entries → throws incomplete_phase_output', async () => {
    const cwd = tmpCwd();
    const diff = fakeDiffProvider([{ path: 'data/deltas/20260527.sql', after: `
      CREATE TABLE foo (id uuid);
      ALTER TABLE foo ADD COLUMN bar text;
    ` }]);
    const run = await AutopilotRun.create(baseOpts(cwd, ['data/deltas/*.sql'], diff));
    await run.beginPhase('spec', {});
    await run.endPhase('spec', { path: 'docs/foo.md', sha: SHA256, size: 1 });
    await run.beginPhase('plan', {});
    await run.endPhase('plan', { path: 'docs/foo-plan.md', sha: SHA256, size: 1 });
    await run.beginPhase('worktree', {});
    await run.endPhase('worktree', { path: '/tmp/wt', branch: 'feature/x', createdAt: '2026-01-01T00:00:00Z' });
    await run.beginPhase('implement', {});
    // Only one entry but diff has two statements.
    await assert.rejects(
      run.endPhase('implement', {
        ...IMPLEMENT_OUT,
        schemaChanges: [{
          file: 'data/deltas/20260527.sql',
          kind: 'sql.create_table',
          objectName: 'foo',
          statementIndex: 0,
          additive: true,
          description: 'CREATE TABLE foo',
        }],
      }),
      /incomplete_phase_output|schema-change manifest/,
    );
    await run.release();
  });
});
