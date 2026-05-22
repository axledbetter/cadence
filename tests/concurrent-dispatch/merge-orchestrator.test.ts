// tests/concurrent-dispatch/merge-orchestrator.test.ts
//
// Real-git integration tests for the v7.11.0 merge orchestrator (PR 5/6,
// issue #192). Covers acceptance bullets:
//
//   * Multi-commit cherry-pick lands ALL commits in plan order
//   * Conflict diagnostics persisted BEFORE `cherry-pick --abort` runs
//   * Precondition violations (dirty tree, wrong branch, in-progress
//     cherry-pick, HEAD SHA mismatch) → task.merge_aborted, no auto-fix
//   * Ancestry verified at merge time under the lock
//   * No-commits-at-merge rejected
//   * Successful merge cleans up worktree + branch
//   * Integration worktree isolation — main repo HEAD untouched
//   * Sequential multi-task merge advances HEAD correctly
//
// Each test spins up a fresh ephemeral git repo, sets up a linked
// integration worktree on `feature/test`, creates per-task worktrees via
// the real `WorktreeLifecycle`, and exercises the orchestrator end-to-end.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GitOperationQueue } from '../../src/core/concurrent-dispatch/git-op-queue.ts';
import {
  WorktreeLifecycle,
  type CreatedTaskWorktree,
} from '../../src/core/concurrent-dispatch/worktree-lifecycle.ts';
import {
  createMergeOrchestrator,
  type MergeableTask,
  type MergeOrchestrator,
} from '../../src/core/concurrent-dispatch/merge-orchestrator.ts';
import { SerializedWriter } from '../../src/core/run-state/serialized-writer.ts';
import type { WriterId } from '../../src/core/run-state/types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

interface TestEnv {
  repoDir: string;
  integrationWorktree: string;
  runWorktreesDir: string;
  runStateDir: string;
  runId: string;
  repoLockPath: string;
  featureBranch: string;
  initialFeatureBranchSha: string;
  lifecycle: WorktreeLifecycle;
  writer: SerializedWriter;
  gitQueue: GitOperationQueue;
  orchestrator: MergeOrchestrator;
  eventsPath: string;
  cleanup: () => Promise<void>;
}

const WRITER_ID: WriterId = { pid: process.pid, hostHash: 'test' };

async function setupEnv(): Promise<TestEnv> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-repo-'));
  git(repoDir, 'init', '--initial-branch=main');
  git(repoDir, 'config', 'user.email', 'test@example.com');
  git(repoDir, 'config', 'user.name', 'Test');
  git(repoDir, 'config', 'commit.gpgsign', 'false');

  // Seed an initial commit on `main`.
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n');
  git(repoDir, 'add', 'README.md');
  git(repoDir, 'commit', '-m', 'initial');

  // Create the feature branch ref WITHOUT checking it out in the main
  // worktree — PR6 spec says Step 2 of autopilot should not check out the
  // feature branch in the main worktree. We approximate by leaving main on
  // `main` and creating an integration worktree elsewhere.
  const featureBranch = 'feature/test';
  git(repoDir, 'branch', featureBranch);

  const runId = '01HZTEST' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const runWorktreesDir = path.join(repoDir, '.claude', 'worktrees', runId);
  const integrationWorktree = path.join(runWorktreesDir, 'integration');
  const runStateDir = path.join(repoDir, '.claude', 'run-state', runId);
  const repoLockPath = path.join(repoDir, '.claude', 'run-state', 'repo.lock');

  fs.mkdirSync(runStateDir, { recursive: true });
  fs.mkdirSync(runWorktreesDir, { recursive: true });

  // `git worktree add` is the SOLE checkout of feature/test — main worktree
  // stays on `main`.
  git(repoDir, 'worktree', 'add', integrationWorktree, featureBranch);
  const initialFeatureBranchSha = git(
    integrationWorktree,
    'rev-parse',
    'HEAD',
  ).trim();

  const gitQueue = new GitOperationQueue();
  const lifecycle = new WorktreeLifecycle({
    integrationWorktree,
    runWorktreesDir,
    runId,
    gitQueue,
  });

  const eventsPath = path.join(runStateDir, 'events.ndjson');
  const writer = await SerializedWriter.create({
    eventsNdjsonPath: eventsPath,
    writerId: WRITER_ID,
    runId,
  });

  const orchestrator = createMergeOrchestrator({
    writer,
    gitQueue,
    runId,
    featureBranch,
    integrationWorktreePath: integrationWorktree,
    runStateDir,
    repoLockPath,
    lifecycle,
    initialFeatureBranchSha,
  });

  return {
    repoDir,
    integrationWorktree,
    runWorktreesDir,
    runStateDir,
    runId,
    repoLockPath,
    featureBranch,
    initialFeatureBranchSha,
    lifecycle,
    writer,
    gitQueue,
    orchestrator,
    eventsPath,
    cleanup: async () => {
      await writer.close();
      try {
        fs.rmSync(repoDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

function readEvents(eventsPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(eventsPath)) return [];
  const raw = fs.readFileSync(eventsPath, 'utf8');
  return raw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

function commitOnTaskWorktree(
  worktreePath: string,
  filename: string,
  content: string,
  message: string,
): string {
  fs.writeFileSync(path.join(worktreePath, filename), content);
  git(worktreePath, 'add', filename);
  git(worktreePath, 'commit', '-m', message);
  return git(worktreePath, 'rev-parse', 'HEAD').trim();
}

async function setupTask(
  env: TestEnv,
  taskId: string,
  commits: Array<{ filename: string; content: string; message: string }>,
): Promise<{ created: CreatedTaskWorktree; mergeable: MergeableTask; commitShas: string[] }> {
  const created = await env.lifecycle.createTaskWorktree(taskId);
  const commitShas: string[] = [];
  for (const c of commits) {
    commitShas.push(commitOnTaskWorktree(created.worktreePath, c.filename, c.content, c.message));
  }
  const tipSha =
    commitShas.length > 0
      ? commitShas[commitShas.length - 1]!
      : created.baseSha;
  return {
    created,
    mergeable: {
      task_id: taskId,
      base_sha: created.baseSha,
      task_branch_tip_sha: tipSha,
      task_branch_name: created.branch,
    },
    commitShas,
  };
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('MergeOrchestrator.mergeTask — happy path', () => {
  it('cherry-picks a multi-commit task branch and lands ALL commits in order', async () => {
    const env = await setupEnv();
    try {
      const { mergeable } = await setupTask(env, '1', [
        { filename: 'a.txt', content: 'A\n', message: 'add a' },
        { filename: 'b.txt', content: 'B\n', message: 'add b' },
        { filename: 'c.txt', content: 'C\n', message: 'add c' },
      ]);

      const before = git(env.integrationWorktree, 'rev-parse', 'HEAD').trim();
      const result = await env.orchestrator.mergeTask(mergeable);

      assert.equal(result.status, 'merged');
      if (result.status !== 'merged') return;

      // 3 commits should be present in oldest→newest order on feature/test
      // beyond `before`.
      const log = git(
        env.integrationWorktree,
        'log',
        '--format=%s',
        `${before}..HEAD`,
      )
        .trim()
        .split('\n')
        .reverse(); // git log is newest-first; reverse to oldest-first
      assert.deepEqual(log, ['add a', 'add b', 'add c']);

      // Files exist on the feature branch checkout.
      assert.ok(fs.existsSync(path.join(env.integrationWorktree, 'a.txt')));
      assert.ok(fs.existsSync(path.join(env.integrationWorktree, 'b.txt')));
      assert.ok(fs.existsSync(path.join(env.integrationWorktree, 'c.txt')));

      // task.merged event was emitted.
      const events = readEvents(env.eventsPath);
      const merged = events.find(e => e.event === 'task.merged' && e.task_id === '1');
      assert.ok(merged, 'task.merged event should exist');
      assert.equal(merged!.feature_branch_sha_after_merge, result.feature_branch_sha_after_merge);

      // Expected HEAD is advanced.
      assert.equal(env.orchestrator.expectedFeatureBranchSha(), result.feature_branch_sha_after_merge);
    } finally {
      await env.cleanup();
    }
  });

  it('cleans up task worktree + branch after successful merge', async () => {
    const env = await setupEnv();
    try {
      const { mergeable, created } = await setupTask(env, '1', [
        { filename: 'x.txt', content: 'X\n', message: 'add x' },
      ]);
      const result = await env.orchestrator.mergeTask(mergeable);
      assert.equal(result.status, 'merged');

      assert.ok(!fs.existsSync(created.worktreePath), 'task worktree dir should be removed');
      // Branch ref should be gone.
      assert.throws(
        () => git(env.integrationWorktree, 'rev-parse', created.branch),
        /unknown revision|not a valid|fatal/,
      );
    } finally {
      await env.cleanup();
    }
  });

  it('leaves the main repo worktree HEAD untouched (integration isolation)', async () => {
    const env = await setupEnv();
    try {
      const mainHeadBefore = git(env.repoDir, 'rev-parse', 'HEAD').trim();
      const mainBranchBefore = git(env.repoDir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();

      const { mergeable } = await setupTask(env, '1', [
        { filename: 'x.txt', content: 'X\n', message: 'add x' },
      ]);
      const result = await env.orchestrator.mergeTask(mergeable);
      assert.equal(result.status, 'merged');

      const mainHeadAfter = git(env.repoDir, 'rev-parse', 'HEAD').trim();
      const mainBranchAfter = git(env.repoDir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
      assert.equal(mainHeadAfter, mainHeadBefore, 'main worktree HEAD must not move');
      assert.equal(mainBranchAfter, mainBranchBefore, 'main worktree branch must not change');
      assert.equal(mainBranchBefore, 'main', 'sanity: main worktree should be on main');
    } finally {
      await env.cleanup();
    }
  });

  it('merges multiple tasks sequentially, advancing feature branch SHA correctly', async () => {
    const env = await setupEnv();
    try {
      // Task 1 → 1 commit. Task 2 (after task 1 merges) → 2 commits. Task 3 → 1 commit.
      const t1 = await setupTask(env, '1', [
        { filename: 't1.txt', content: 'T1\n', message: 't1' },
      ]);
      const r1 = await env.orchestrator.mergeTask(t1.mergeable);
      assert.equal(r1.status, 'merged');
      if (r1.status !== 'merged') return;

      // task 2 dispatched AFTER task 1 merges — base_sha is the new HEAD.
      const t2 = await setupTask(env, '2', [
        { filename: 't2a.txt', content: 'T2A\n', message: 't2a' },
        { filename: 't2b.txt', content: 'T2B\n', message: 't2b' },
      ]);
      const r2 = await env.orchestrator.mergeTask(t2.mergeable);
      assert.equal(r2.status, 'merged');
      if (r2.status !== 'merged') return;

      const t3 = await setupTask(env, '3', [
        { filename: 't3.txt', content: 'T3\n', message: 't3' },
      ]);
      const r3 = await env.orchestrator.mergeTask(t3.mergeable);
      assert.equal(r3.status, 'merged');
      if (r3.status !== 'merged') return;

      // 4 commits total beyond initial (1 + 2 + 1).
      const count = parseInt(
        git(
          env.integrationWorktree,
          'rev-list',
          '--count',
          `${env.initialFeatureBranchSha}..HEAD`,
        ).trim(),
        10,
      );
      assert.equal(count, 4);

      // Expected SHA tracking matches the actual integration HEAD.
      const head = git(env.integrationWorktree, 'rev-parse', 'HEAD').trim();
      assert.equal(env.orchestrator.expectedFeatureBranchSha(), head);
      assert.equal(r3.feature_branch_sha_after_merge, head);
    } finally {
      await env.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Conflict path
// ---------------------------------------------------------------------------

describe('MergeOrchestrator.mergeTask — conflict path', () => {
  it('captures diagnostics BEFORE aborting and emits task.merge_conflict', async () => {
    const env = await setupEnv();
    try {
      // Task A modifies foo.txt with content X and merges.
      const tA = await setupTask(env, 'a', [
        { filename: 'foo.txt', content: 'X\n', message: 'A: set foo to X' },
      ]);
      const rA = await env.orchestrator.mergeTask(tA.mergeable);
      assert.equal(rA.status, 'merged');

      // Task B's base_sha was captured BEFORE task A merged — so task B
      // starts from the old base. We force this by creating B's worktree
      // BEFORE merging A. Actually for our test fixture, task A is already
      // merged. Recreate the scenario: a task whose base is the initial
      // feature branch SHA, modifying the same file, after task A landed.
      //
      // Approach: create task B's worktree manually pointing at the initial
      // base, commit a conflicting change, then attempt to merge.
      const taskBId = 'b';
      const taskBBranch = `autopilot/${env.runId}/${taskBId}`;
      const taskBPath = path.join(env.runWorktreesDir, taskBId);
      git(
        env.integrationWorktree,
        'worktree',
        'add',
        taskBPath,
        '-b',
        taskBBranch,
        env.initialFeatureBranchSha,
      );
      fs.writeFileSync(path.join(taskBPath, 'foo.txt'), 'Y\n');
      git(taskBPath, 'add', 'foo.txt');
      git(taskBPath, 'commit', '-m', 'B: set foo to Y');
      const taskBTip = git(taskBPath, 'rev-parse', 'HEAD').trim();

      const result = await env.orchestrator.mergeTask({
        task_id: taskBId,
        base_sha: env.initialFeatureBranchSha,
        task_branch_tip_sha: taskBTip,
        task_branch_name: taskBBranch,
      });

      assert.equal(result.status, 'conflict');
      if (result.status !== 'conflict') return;

      // Conflict report path: under <runStateDir>/conflicts/<taskId>.md
      assert.ok(
        result.conflict_report_path.endsWith(path.join('conflicts', `${taskBId}.md`)),
        `report path should end in conflicts/${taskBId}.md, got ${result.conflict_report_path}`,
      );
      assert.ok(
        fs.existsSync(result.conflict_report_path),
        'conflict report file should exist on disk',
      );

      // Report mentions the conflicting file.
      const report = fs.readFileSync(result.conflict_report_path, 'utf8');
      assert.match(report, /foo\.txt/);
      assert.match(report, /Tip SHA/);
      assert.match(report, /Base SHA/);

      // Conflicting paths list should include foo.txt.
      assert.ok(
        result.conflicting_paths.some(p => p === 'foo.txt'),
        `conflicting_paths should list foo.txt, got ${JSON.stringify(result.conflicting_paths)}`,
      );

      // After abort, working tree is clean (no in-progress cherry-pick).
      const porcelain = git(env.integrationWorktree, 'status', '--porcelain').trim();
      assert.equal(porcelain, '', 'cherry-pick --abort should have left a clean tree');

      // task.merge_conflict event present with the diagnostics fields.
      const events = readEvents(env.eventsPath);
      const conflict = events.find(
        e => e.event === 'task.merge_conflict' && e.task_id === taskBId,
      );
      assert.ok(conflict, 'task.merge_conflict event should exist');
      assert.deepEqual(conflict!.conflicting_paths, result.conflicting_paths);
      assert.equal(conflict!.conflict_report_path, result.conflict_report_path);

      // Expected HEAD did NOT advance.
      assert.equal(
        env.orchestrator.expectedFeatureBranchSha(),
        rA.status === 'merged' ? rA.feature_branch_sha_after_merge : env.initialFeatureBranchSha,
      );
    } finally {
      await env.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Precondition violations
// ---------------------------------------------------------------------------

describe('MergeOrchestrator.mergeTask — preconditions', () => {
  it('aborts with dirty_tree when working tree has uncommitted changes', async () => {
    const env = await setupEnv();
    try {
      // Dirty the integration worktree.
      fs.writeFileSync(path.join(env.integrationWorktree, 'dirty.txt'), 'dirty\n');

      const { mergeable } = await setupTask(env, '1', [
        { filename: 'a.txt', content: 'A\n', message: 'add a' },
      ]);
      const result = await env.orchestrator.mergeTask(mergeable);

      assert.equal(result.status, 'aborted');
      if (result.status !== 'aborted') return;
      assert.equal(result.precondition_violated, 'dirty_tree');
      assert.match(result.reason, /uncommitted/i);

      const events = readEvents(env.eventsPath);
      const aborted = events.find(e => e.event === 'task.merge_aborted' && e.task_id === '1');
      assert.ok(aborted, 'task.merge_aborted should be emitted');
      assert.equal(aborted!.precondition_violated, 'dirty_tree');
    } finally {
      await env.cleanup();
    }
  });

  it('aborts with wrong_head_branch when integration worktree is on a different branch', async () => {
    const env = await setupEnv();
    try {
      // Switch the integration worktree off feature/test.
      git(env.integrationWorktree, 'checkout', '-b', 'wrong-branch');

      const { mergeable } = await setupTask(env, '1', [
        { filename: 'a.txt', content: 'A\n', message: 'add a' },
      ]);
      const result = await env.orchestrator.mergeTask(mergeable);

      assert.equal(result.status, 'aborted');
      if (result.status !== 'aborted') return;
      assert.equal(result.precondition_violated, 'wrong_head_branch');
      assert.match(result.reason, /wrong-branch/);
    } finally {
      await env.cleanup();
    }
  });

  it('aborts with in_progress_cherry_pick_head when CHERRY_PICK_HEAD exists', async () => {
    const env = await setupEnv();
    try {
      // Stage a stray CHERRY_PICK_HEAD in the worktree's git dir. For a
      // linked worktree, that's at .git/worktrees/<name>/CHERRY_PICK_HEAD.
      const gitDirRel = git(env.integrationWorktree, 'rev-parse', '--git-dir').trim();
      const gitDirAbs = path.isAbsolute(gitDirRel)
        ? gitDirRel
        : path.resolve(env.integrationWorktree, gitDirRel);
      fs.writeFileSync(path.join(gitDirAbs, 'CHERRY_PICK_HEAD'), env.initialFeatureBranchSha + '\n');

      const { mergeable } = await setupTask(env, '1', [
        { filename: 'a.txt', content: 'A\n', message: 'add a' },
      ]);
      const result = await env.orchestrator.mergeTask(mergeable);

      assert.equal(result.status, 'aborted');
      if (result.status !== 'aborted') return;
      assert.equal(result.precondition_violated, 'in_progress_cherry_pick_head');

      // Clean up so the cleanup() afterwards doesn't trip on the bogus marker.
      try {
        fs.unlinkSync(path.join(gitDirAbs, 'CHERRY_PICK_HEAD'));
      } catch {
        // best-effort
      }
    } finally {
      await env.cleanup();
    }
  });

  it('aborts with head_sha_mismatch when integration HEAD was moved out-of-band', async () => {
    const env = await setupEnv();
    try {
      // First, create+commit a stray commit DIRECTLY on the integration
      // worktree (simulating someone touching the feature branch outside
      // the orchestrator).
      fs.writeFileSync(path.join(env.integrationWorktree, 'rogue.txt'), 'rogue\n');
      git(env.integrationWorktree, 'add', 'rogue.txt');
      git(env.integrationWorktree, 'commit', '-m', 'rogue commit');

      const { mergeable } = await setupTask(env, '1', [
        { filename: 'a.txt', content: 'A\n', message: 'add a' },
      ]);
      const result = await env.orchestrator.mergeTask(mergeable);

      assert.equal(result.status, 'aborted');
      if (result.status !== 'aborted') return;
      assert.equal(result.precondition_violated, 'head_sha_mismatch');
      assert.match(result.reason, /does not match expected/);
    } finally {
      await env.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Ancestry + no-commits at merge time
// ---------------------------------------------------------------------------

describe('MergeOrchestrator.mergeTask — ancestry / empty range', () => {
  it('aborts with ancestry_violation_at_merge_time when tip is not a descendant of base', async () => {
    const env = await setupEnv();
    try {
      // Create a "task" whose tip is an orphan SHA — no ancestor relationship
      // with base_sha. We do this by setting up a real worktree, then
      // overwriting the branch ref to an orphan commit.
      const taskId = '1';
      const { created } = await setupTask(env, taskId, [
        { filename: 'a.txt', content: 'A\n', message: 'add a' },
      ]);
      // Build an orphan commit in the task worktree.
      git(created.worktreePath, 'checkout', '--orphan', 'orphan-tmp');
      git(created.worktreePath, 'rm', '-rf', '.');
      fs.writeFileSync(path.join(created.worktreePath, 'orphan.txt'), 'orphan\n');
      git(created.worktreePath, 'add', 'orphan.txt');
      git(created.worktreePath, 'commit', '-m', 'orphan');
      const orphanSha = git(created.worktreePath, 'rev-parse', 'HEAD').trim();
      git(created.worktreePath, 'branch', '-f', created.branch, orphanSha);

      const result = await env.orchestrator.mergeTask({
        task_id: taskId,
        base_sha: created.baseSha,
        task_branch_tip_sha: orphanSha,
        task_branch_name: created.branch,
      });

      assert.equal(result.status, 'aborted');
      if (result.status !== 'aborted') return;
      assert.equal(result.precondition_violated, 'ancestry_violation_at_merge_time');

      const events = readEvents(env.eventsPath);
      const aborted = events.find(e => e.event === 'task.merge_aborted' && e.task_id === taskId);
      assert.ok(aborted, 'task.merge_aborted should be emitted');
      assert.equal(aborted!.precondition_violated, 'ancestry_violation_at_merge_time');
    } finally {
      await env.cleanup();
    }
  });

  it('aborts with no_commits_at_merge when base..tip is empty', async () => {
    const env = await setupEnv();
    try {
      const { created } = await setupTask(env, '1', []); // no commits

      const result = await env.orchestrator.mergeTask({
        task_id: '1',
        base_sha: created.baseSha,
        task_branch_tip_sha: created.baseSha, // tip == base → empty range
        task_branch_name: created.branch,
      });

      assert.equal(result.status, 'aborted');
      if (result.status !== 'aborted') return;
      assert.equal(result.precondition_violated, 'no_commits_at_merge');
    } finally {
      await env.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Lock + queue routing — light-touch check that we don't deadlock with the
// scheduler's queue/lock invariants.
// ---------------------------------------------------------------------------

describe('MergeOrchestrator.mergeTask — input validation', () => {
  it('aborts with invalid_task_id when task_id contains path-traversal segments', async () => {
    const env = await setupEnv();
    try {
      // We can't go through setupTask (which would fail at WorktreeLifecycle's
      // own validator) — construct a MergeableTask by hand.
      const result = await env.orchestrator.mergeTask({
        task_id: '../etc/passwd',
        base_sha: env.initialFeatureBranchSha,
        task_branch_tip_sha: env.initialFeatureBranchSha,
        task_branch_name: `autopilot/${env.runId}/../etc/passwd`,
      });
      assert.equal(result.status, 'aborted');
      if (result.status !== 'aborted') return;
      assert.equal(result.precondition_violated, 'invalid_task_id');

      // Ensure no file was written outside the conflicts dir.
      assert.ok(!fs.existsSync('/etc/passwd.md'));
    } finally {
      await env.cleanup();
    }
  });

  it('aborts with invalid_base_sha when base_sha is not a 40-char hex string', async () => {
    const env = await setupEnv();
    try {
      const result = await env.orchestrator.mergeTask({
        task_id: '1',
        base_sha: 'HEAD',
        task_branch_tip_sha: env.initialFeatureBranchSha,
        task_branch_name: `autopilot/${env.runId}/1`,
      });
      assert.equal(result.status, 'aborted');
      if (result.status !== 'aborted') return;
      assert.equal(result.precondition_violated, 'invalid_base_sha');
    } finally {
      await env.cleanup();
    }
  });

  it('aborts with invalid_task_id when task_id contains git-ref-forbidden sequences (`..`, trailing `.`)', async () => {
    const env = await setupEnv();
    try {
      for (const badId of ['a..b', 'abc.', 'foo@{1}']) {
        const result = await env.orchestrator.mergeTask({
          task_id: badId,
          base_sha: env.initialFeatureBranchSha,
          task_branch_tip_sha: env.initialFeatureBranchSha,
          task_branch_name: `autopilot/${env.runId}/${badId}`,
        });
        assert.equal(result.status, 'aborted', `bad id "${badId}" should abort`);
        if (result.status !== 'aborted') return;
        assert.equal(result.precondition_violated, 'invalid_task_id');
      }
    } finally {
      await env.cleanup();
    }
  });

  it('factory throws when runId fails ref-format validation', async () => {
    const env = await setupEnv();
    try {
      assert.throws(
        () =>
          createMergeOrchestrator({
            writer: env.writer,
            gitQueue: env.gitQueue,
            runId: '../etc/passwd',
            featureBranch: env.featureBranch,
            integrationWorktreePath: env.integrationWorktree,
            runStateDir: env.runStateDir,
            repoLockPath: env.repoLockPath,
            lifecycle: env.lifecycle,
            initialFeatureBranchSha: env.initialFeatureBranchSha,
          }),
        /run_id/,
      );
    } finally {
      await env.cleanup();
    }
  });

  it('aborts with invalid_branch_name when task_branch_name does not match autopilot/<runId>/<taskId>', async () => {
    const env = await setupEnv();
    try {
      const result = await env.orchestrator.mergeTask({
        task_id: '1',
        base_sha: env.initialFeatureBranchSha,
        task_branch_tip_sha: env.initialFeatureBranchSha,
        task_branch_name: 'main', // would otherwise be deleted by cleanup!
      });
      assert.equal(result.status, 'aborted');
      if (result.status !== 'aborted') return;
      assert.equal(result.precondition_violated, 'invalid_branch_name');

      // main branch must still exist.
      const mainSha = git(env.repoDir, 'rev-parse', 'main').trim();
      assert.equal(mainSha.length, 40);
    } finally {
      await env.cleanup();
    }
  });
});

describe('MergeOrchestrator.mergeTask — concurrency primitives', () => {
  it('routes through both the git queue and the repo lock without deadlocking', async () => {
    const env = await setupEnv();
    try {
      const { mergeable } = await setupTask(env, '1', [
        { filename: 'a.txt', content: 'A\n', message: 'add a' },
      ]);

      // Kick off the merge AND a concurrent gitQueue op. The gitQueue.enqueue
      // call should run AFTER the merge releases its enqueue slot.
      let counter = 0;
      const post = env.gitQueue.enqueue(async () => {
        counter += 1;
      });

      const result = await env.orchestrator.mergeTask(mergeable);
      assert.equal(result.status, 'merged');
      await post;
      assert.equal(counter, 1);
    } finally {
      await env.cleanup();
    }
  });
});
