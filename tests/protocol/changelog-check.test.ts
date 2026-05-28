/**
 * CI gate test — assert scripts/protocol-changelog-check.ts catches
 * PRs that modify schemas / migrations without a matching changelog
 * entry.
 *
 * We init a synthetic git repo in a tmp dir, stage commits that match
 * each scenario, and invoke runCheck() with that repo as cwd.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runCheck } from '../../scripts/protocol-changelog-check.ts';

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-changelog-check-'));
  git(dir, ['init', '-q', '--initial-branch=master']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  // Master baseline — empty repo with a README so HEAD exists.
  fs.writeFileSync(path.join(dir, 'README.md'), '# baseline\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'baseline']);
  return dir;
}

function write(repo: string, file: string, contents: string): void {
  const full = path.join(repo, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

describe('protocol-changelog-check — PR-on-feature-branch', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkRepo();
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('passes when no tracked files change', () => {
    // Add a non-tracked file.
    write(repo, 'src/cli/index.ts', '// unrelated change\n');
    git(repo, ['checkout', '-q', '-b', 'feature/test']);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'unrelated change']);
    const result = runCheck(repo);
    assert.equal(result.exitCode, 0);
    assert.equal(result.trackedChanged.length, 0);
    assert.match(result.message, /skipped|tracked/);
  });

  it('fails when a schema changes without a changelog entry', () => {
    git(repo, ['checkout', '-q', '-b', 'feature/schema-bump']);
    write(repo, 'presets/schemas/profile-2.0.0.json', '{}');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'add 2.0.0 schema']);
    const result = runCheck(repo);
    assert.equal(result.exitCode, 1);
    assert.equal(result.trackedChanged.length, 1);
    assert.equal(result.changelogChanged, false);
    assert.match(result.message, /FAILED/);
  });

  it('passes when a schema changes WITH a changelog entry', () => {
    git(repo, ['checkout', '-q', '-b', 'feature/schema-bump-with-doc']);
    write(repo, 'presets/schemas/profile-2.0.0.json', '{}');
    write(repo, 'src/core/protocol/changelog.md', '# changelog\n## 2.0.0\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'bump + doc']);
    const result = runCheck(repo);
    assert.equal(result.exitCode, 0);
    assert.equal(result.trackedChanged.length, 1);
    assert.equal(result.changelogChanged, true);
  });

  it('fails when version.ts changes without a changelog entry', () => {
    git(repo, ['checkout', '-q', '-b', 'feature/version-bump']);
    write(repo, 'src/core/protocol/version.ts', '// new version\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'bump version.ts']);
    const result = runCheck(repo);
    assert.equal(result.exitCode, 1);
    assert.equal(result.trackedChanged.length, 1);
  });

  it('ignores per-component index.ts boilerplate', () => {
    git(repo, ['checkout', '-q', '-b', 'feature/index-only']);
    write(repo, 'src/core/protocol/migrations/profile/index.ts', '// no migrations\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'touch index.ts']);
    const result = runCheck(repo);
    assert.equal(result.exitCode, 0);
    assert.equal(result.trackedChanged.length, 0);
  });

  it('catches real migration files without changelog', () => {
    git(repo, ['checkout', '-q', '-b', 'feature/new-migration']);
    write(
      repo,
      'src/core/protocol/migrations/profile/1.0.0-to-1.1.0.ts',
      'export const migration = {};\n',
    );
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'add migration']);
    const result = runCheck(repo);
    assert.equal(result.exitCode, 1);
    assert.equal(result.trackedChanged.length, 1);
  });
});
