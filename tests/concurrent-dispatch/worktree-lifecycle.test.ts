// tests/concurrent-dispatch/worktree-lifecycle.test.ts
//
// Real-git integration tests for the per-task worktree lifecycle (PR 4/6,
// v7.11.0). Covers issue #191 acceptance bullets:
//
//   * Per-task worktree create / cleanup
//   * base_sha capture matches integration worktree HEAD at create time
//   * Ancestry validation rejects rebased-off-different-base branches
//   * No-commits detection via `rev-list --count base..tip`
//   * State-based cleanup — only `merged` removes; other states preserve
//   * Worktree-path-collision refusal points at `runs gc`
//
// Each test spins up a fresh ephemeral git repo in os.tmpdir(), creates a
// `feature/test` branch as the integration target, then exercises the
// lifecycle helpers. We intentionally use real `git worktree add` / `git
// commit` so the tests catch regressions in the shell command formatting.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GitOperationQueue } from '../../src/core/concurrent-dispatch/git-op-queue.ts';
import {
  WorktreeLifecycle,
  assertRunWorktreesDirAvailable,
} from '../../src/core/concurrent-dispatch/worktree-lifecycle.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

interface TestRepo {
  repoDir: string;
  integrationWorktree: string;
  runWorktreesDir: string;
  runId: string;
  cleanup: () => void;
}

function setupRepo(): TestRepo {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-repo-'));
  git(repoDir, 'init', '--initial-branch=main');
  git(repoDir, 'config', 'user.email', 'test@example.com');
  git(repoDir, 'config', 'user.name', 'Test');
  // Disable GPG signing if the global config requires it.
  git(repoDir, 'config', 'commit.gpgsign', 'false');
  // Create a base commit so HEAD has a SHA.
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n');
  git(repoDir, 'add', 'README.md');
  git(repoDir, 'commit', '-m', 'initial');
  // Create the feature branch and use it as the integration worktree's
  // checkout. We DON'T mirror the spec's "linked integration worktree"
  // exactly — the main repo dir IS the integration worktree for test
  // purposes, which simplifies the fixture without changing semantics.
  git(repoDir, 'checkout', '-b', 'feature/test');

  const runId = '01HZTEST' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const runWorktreesDir = path.join(repoDir, '.claude', 'worktrees', runId);

  return {
    repoDir,
    integrationWorktree: repoDir,
    runWorktreesDir,
    runId,
    cleanup: () => {
      try {
        fs.rmSync(repoDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

function newLifecycle(repo: TestRepo): WorktreeLifecycle {
  return new WorktreeLifecycle({
    integrationWorktree: repo.integrationWorktree,
    runWorktreesDir: repo.runWorktreesDir,
    runId: repo.runId,
    gitQueue: new GitOperationQueue(),
  });
}

function writeCommit(worktreePath: string, filename: string, content: string, message: string): string {
  fs.writeFileSync(path.join(worktreePath, filename), content);
  git(worktreePath, 'add', filename);
  git(worktreePath, 'commit', '-m', message);
  return git(worktreePath, 'rev-parse', 'HEAD').trim();
}

describe('WorktreeLifecycle.createTaskWorktree', () => {
  it('creates a worktree at the expected path with the recorded base_sha', async () => {
    const repo = setupRepo();
    try {
      const lifecycle = newLifecycle(repo);
      const expectedBaseSha = git(repo.integrationWorktree, 'rev-parse', 'HEAD').trim();

      const created = await lifecycle.createTaskWorktree('1');

      assert.equal(created.baseSha, expectedBaseSha);
      assert.equal(created.branch, `autopilot/${repo.runId}/1`);
      assert.equal(created.worktreePath, path.join(repo.runWorktreesDir, '1'));
      assert.ok(fs.existsSync(created.worktreePath));
      // The branch should exist and point at base_sha (no commits yet).
      const branchSha = git(repo.integrationWorktree, 'rev-parse', created.branch).trim();
      assert.equal(branchSha, expectedBaseSha);
    } finally {
      repo.cleanup();
    }
  });

  it('refuses when the worktree path already exists (points at runs gc)', async () => {
    const repo = setupRepo();
    try {
      const lifecycle = newLifecycle(repo);
      // Pre-create the collision dir.
      fs.mkdirSync(path.join(repo.runWorktreesDir, '1'), { recursive: true });

      await assert.rejects(
        lifecycle.createTaskWorktree('1'),
        (err: Error & { details?: { recovery?: string } }) => {
          assert.match(err.message, /worktree path already exists/);
          assert.match(err.message, /runs gc/);
          assert.ok(err.details?.recovery?.includes('runs gc'));
          return true;
        },
      );
    } finally {
      repo.cleanup();
    }
  });
});

describe('WorktreeLifecycle.verifyTaskCommits', () => {
  it('classifies a no-commits branch as kind=no_commits', async () => {
    const repo = setupRepo();
    try {
      const lifecycle = newLifecycle(repo);
      const created = await lifecycle.createTaskWorktree('1');
      // Subagent simulates "did nothing" — never commits.
      const verification = await lifecycle.verifyTaskCommits('1', created.baseSha);
      assert.equal(verification.kind, 'no_commits');
    } finally {
      repo.cleanup();
    }
  });

  it('classifies a happy-path branch as kind=ok with ordered commit SHAs', async () => {
    const repo = setupRepo();
    try {
      const lifecycle = newLifecycle(repo);
      const created = await lifecycle.createTaskWorktree('1');

      // Simulate a subagent making two commits.
      const sha1 = writeCommit(created.worktreePath, 'a.txt', 'A\n', 'add a');
      const sha2 = writeCommit(created.worktreePath, 'b.txt', 'B\n', 'add b');

      const verification = await lifecycle.verifyTaskCommits('1', created.baseSha);
      assert.equal(verification.kind, 'ok');
      if (verification.kind !== 'ok') return;
      assert.equal(verification.tipSha, sha2);
      // commit_shas should be oldest-first.
      assert.deepEqual(verification.commitShas, [sha1, sha2]);
    } finally {
      repo.cleanup();
    }
  });

  it('classifies a rebased-off-different-base branch as ancestry_violation', async () => {
    const repo = setupRepo();
    try {
      const lifecycle = newLifecycle(repo);
      // Capture base_sha at this point.
      const created = await lifecycle.createTaskWorktree('1');

      // Subagent commits something.
      writeCommit(created.worktreePath, 'a.txt', 'A\n', 'add a');

      // Now poison the branch: rebase its tip off a totally different
      // base (a fresh commit on `feature/test` that the task branch never
      // saw). We do this by:
      //   1. making an unrelated commit on feature/test
      //   2. checking out a NEW orphan branch from that commit in the
      //      task worktree, force-resetting the task branch to it
      // This is a stylized version of "subagent reset --hard to somewhere
      // else" — the ancestry chain no longer includes baseSha.

      // Make an orphan commit (no parent) directly inside the task worktree.
      git(created.worktreePath, 'checkout', '--orphan', 'temp-orphan');
      // Clean working tree.
      git(created.worktreePath, 'rm', '-rf', '.');
      fs.writeFileSync(path.join(created.worktreePath, 'orphan.txt'), 'orphan\n');
      git(created.worktreePath, 'add', 'orphan.txt');
      git(created.worktreePath, 'commit', '-m', 'orphan');
      const orphanSha = git(created.worktreePath, 'rev-parse', 'HEAD').trim();

      // Force the task branch to point at the orphan commit.
      git(created.worktreePath, 'branch', '-f', created.branch, orphanSha);
      git(created.worktreePath, 'checkout', created.branch);

      const verification = await lifecycle.verifyTaskCommits('1', created.baseSha);
      assert.equal(verification.kind, 'ancestry_violation');
      if (verification.kind !== 'ancestry_violation') return;
      assert.equal(verification.tipSha, orphanSha);
      assert.match(verification.reason, /not an ancestor/);
    } finally {
      repo.cleanup();
    }
  });
});

describe('WorktreeLifecycle.cleanupTaskWorktree (state-based)', () => {
  it("removes worktree and branch when state='merged'", async () => {
    const repo = setupRepo();
    try {
      const lifecycle = newLifecycle(repo);
      const created = await lifecycle.createTaskWorktree('1');
      writeCommit(created.worktreePath, 'a.txt', 'A\n', 'add a');

      await lifecycle.cleanupTaskWorktree('1', 'merged');

      assert.ok(!fs.existsSync(created.worktreePath), 'worktree dir should be gone');
      // Branch should be deleted.
      assert.throws(
        () => git(repo.integrationWorktree, 'rev-parse', created.branch),
        /unknown revision|not a valid|fatal/,
      );
    } finally {
      repo.cleanup();
    }
  });

  it("preserves worktree + branch when state='failed' and drops a marker file", async () => {
    const repo = setupRepo();
    try {
      const lifecycle = newLifecycle(repo);
      const created = await lifecycle.createTaskWorktree('1');

      await lifecycle.cleanupTaskWorktree('1', 'failed');

      assert.ok(fs.existsSync(created.worktreePath), 'worktree dir should be preserved');
      // Branch should still resolve.
      const sha = git(repo.integrationWorktree, 'rev-parse', created.branch).trim();
      assert.equal(typeof sha, 'string');
      assert.equal(sha.length, 40);
      // Marker file should be written for inspection by `runs cleanup`.
      const markerPath = path.join(created.worktreePath, '.autopilot-state.json');
      assert.ok(fs.existsSync(markerPath), 'marker file should exist for preserved state');
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      assert.equal(marker.task_id, '1');
      assert.equal(marker.terminal_state, 'failed');
      assert.equal(marker.branch, created.branch);
    } finally {
      repo.cleanup();
    }
  });

  // Iterate the preserved states explicitly — node:test doesn't have
  // it.each, so we declare one `it()` per state.
  for (const preservedState of [
    'failed',
    'interrupted',
    'completed-but-unmerged',
    'timeout',
    'merge_conflict',
    'ancestry_violation',
  ] as const) {
    it(`preserves worktree + branch when state='${preservedState}'`, async () => {
      const repo = setupRepo();
      try {
        const lifecycle = newLifecycle(repo);
        const created = await lifecycle.createTaskWorktree('1');
        await lifecycle.cleanupTaskWorktree('1', preservedState);
        assert.ok(fs.existsSync(created.worktreePath), `worktree dir should be preserved for ${preservedState}`);
        const sha = git(repo.integrationWorktree, 'rev-parse', created.branch).trim();
        assert.equal(sha.length, 40, `branch should still exist for ${preservedState}`);
      } finally {
        repo.cleanup();
      }
    });
  }
});

describe('WorktreeLifecycle — task_id sanitization (Codex pass 1 CRITICAL #1)', () => {
  it('rejects task_id containing path traversal segments', async () => {
    const repo = setupRepo();
    try {
      const lifecycle = newLifecycle(repo);
      await assert.rejects(
        lifecycle.createTaskWorktree('../../etc-passwd'),
        (err: Error) => {
          assert.match(err.message, /unsafe/);
          return true;
        },
      );
    } finally {
      repo.cleanup();
    }
  });

  it('rejects task_id containing shell metacharacters', async () => {
    const repo = setupRepo();
    try {
      const lifecycle = newLifecycle(repo);
      await assert.rejects(
        lifecycle.createTaskWorktree('foo;rm-rf'),
        (err: Error) => {
          assert.match(err.message, /unsafe/);
          return true;
        },
      );
    } finally {
      repo.cleanup();
    }
  });

  it('rejects task_id starting with a dash (argv ambiguity)', async () => {
    const repo = setupRepo();
    try {
      const lifecycle = newLifecycle(repo);
      await assert.rejects(
        lifecycle.createTaskWorktree('--help'),
        (err: Error) => {
          assert.match(err.message, /unsafe/);
          return true;
        },
      );
    } finally {
      repo.cleanup();
    }
  });

  it('rejects task_id ending in .lock (git ref restriction)', async () => {
    const repo = setupRepo();
    try {
      const lifecycle = newLifecycle(repo);
      await assert.rejects(
        lifecycle.createTaskWorktree('foo.lock'),
        (err: Error) => {
          assert.match(err.message, /\.lock/);
          return true;
        },
      );
    } finally {
      repo.cleanup();
    }
  });

  it('accepts a normal alphanumeric task_id', async () => {
    const repo = setupRepo();
    try {
      const lifecycle = newLifecycle(repo);
      const created = await lifecycle.createTaskWorktree('task-1_v2');
      assert.ok(fs.existsSync(created.worktreePath));
      assert.equal(created.branch, `autopilot/${repo.runId}/task-1_v2`);
    } finally {
      repo.cleanup();
    }
  });
});

describe('assertRunWorktreesDirAvailable', () => {
  it('does not throw when the dir does not exist', () => {
    const tmp = path.join(os.tmpdir(), 'wl-missing-' + Date.now());
    assert.doesNotThrow(() => assertRunWorktreesDirAvailable(tmp));
  });

  it('does not throw when the dir exists but is empty', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-empty-'));
    try {
      assert.doesNotThrow(() => assertRunWorktreesDirAvailable(tmp));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws with a runs-gc recovery hint when populated', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-pop-'));
    try {
      fs.mkdirSync(path.join(tmp, 'task-1'));
      assert.throws(
        () => assertRunWorktreesDirAvailable(tmp),
        (err: Error & { details?: { recovery?: string } }) => {
          assert.match(err.message, /already populated/);
          assert.match(err.message, /runs gc/);
          assert.ok(err.details?.recovery?.includes('runs gc'));
          return true;
        },
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
