// src/core/concurrent-dispatch/merge-orchestrator.ts
//
// Merge orchestrator for v7.11.0 concurrent subagent dispatch. PR 5 of 6.
//
// Responsibilities (matched to spec section "Merge orchestrator"):
//
//   1. Cherry-pick the IMMUTABLE commit range `base_sha..task_branch_tip_sha`
//      from a completed task branch onto the feature branch in the integration
//      worktree. The range comes verbatim from the `task.completed` event so
//      mutable branch names cannot be subverted between completion and merge.
//
//   2. Verify repo-state preconditions BEFORE touching git:
//        - HEAD is `feature/<topic-slug>` in the integration worktree
//        - Working tree clean (`git status --porcelain` empty)
//        - No in-progress merge/rebase/cherry-pick (no `.git/MERGE_HEAD`,
//          `.git/REBASE_HEAD`, `.git/REBASE_HEAD` dir, or
//          `.git/CHERRY_PICK_HEAD`)
//        - HEAD SHA matches the SHA recorded after the previous merge (or the
//          initial integration-worktree HEAD if no merges yet)
//      A violation emits `task.merge_aborted` with the violating condition;
//      we do NOT auto-fix.
//
//   3. Re-verify ancestry under the lock: `git merge-base --is-ancestor
//      base_sha tip_sha`. A non-zero exit means the task branch was
//      tampered with between `task.completed` emission and merge — emit
//      `task.merge_aborted` with reason `ancestry_violation_at_merge_time`.
//
//   4. Compute the actual commit list with `git rev-list --reverse
//      base_sha..tip_sha`. Empty list (tip==base or all commits already
//      present in HEAD) emits `task.merge_aborted` with reason
//      `no_commits_at_merge`.
//
//   5. Cherry-pick the commit list. On conflict:
//        - CAPTURE DIAGNOSTICS BEFORE ABORT: `git diff --name-only
//          --diff-filter=U`, `git ls-files -u`, `git status --porcelain`
//        - Write a markdown conflict report to
//          `.claude/run-state/<run-ulid>/conflicts/<task-id>.md`
//        - Emit `task.merge_conflict` event with those diagnostics +
//          `conflict_report_path`
//        - `git cherry-pick --abort` to restore a clean tree
//        - Return `{ status: 'conflict', ... }`
//
//   6. On success: read the new HEAD SHA, emit `task.merged` with
//      `feature_branch_sha_after_merge`, then clean up the task worktree +
//      branch (under the same lock). Return `{ status: 'merged', ... }`.
//
// All git operations route through the caller's `GitOperationQueue` (Layer 1
// in-process serialization) and `withRepoLock` (Layer 2 cross-process file
// lock). The orchestrator never re-enters its own queue — `mergeTask` takes
// both locks in a single nested wrap.
//
// Strict plan-order eligibility is the scheduler's responsibility (PR 4 maintains
// a mergeable queue ordered by plan-declaration index and invokes `mergeTask`
// head-first). PR 5 trusts that calls arrive in the right order.
//
// Spec: docs/superpowers/specs/2026-05-19-v7.11.0-concurrent-subagent-execution-design.md
// Issue: https://github.com/axledbetter/claude-autopilot/issues/192

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { GuardrailError } from '../errors.ts';
import { withRepoLock } from '../run-state/repo-lock.ts';
import type { SerializedWriter } from '../run-state/serialized-writer.ts';

import type { GitOperationQueue } from './git-op-queue.ts';
import type { WorktreeLifecycle } from './worktree-lifecycle.ts';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MergeOrchestratorOptions {
  /** Per-run event writer. The orchestrator emits `task.merged`,
   *  `task.merge_conflict`, and `task.merge_aborted` through this. */
  writer: SerializedWriter;
  /** Shared in-process git mutex. All git ops in the orchestrator route
   *  through this. */
  gitQueue: GitOperationQueue;
  /** Run ULID — stamped onto the cross-process lock metadata + included in
   *  conflict-report paths. */
  runId: string;
  /** Fully-qualified feature branch (e.g., `feature/<topic-slug>`). The
   *  integration worktree must have this branch checked out. */
  featureBranch: string;
  /** Absolute path to the integration worktree. The orchestrator is the
   *  SOLE writer to this worktree — Step 2 of the autopilot pipeline (PR 6)
   *  leaves the main worktree on its prior branch so this checkout is the
   *  only one of `featureBranch`. */
  integrationWorktreePath: string;
  /** Absolute path to `.claude/run-state/<run-ulid>/`. Conflict reports
   *  land at `<runStateDir>/conflicts/<task-id>.md`. */
  runStateDir: string;
  /** Absolute path to the cross-process repo lock file (conventionally
   *  `<repo>/.claude/run-state/repo.lock`). */
  repoLockPath: string;
  /** Lifecycle helper for the post-merge cleanup (worktree + branch
   *  removal). The scheduler shares its instance so the cleanup logic
   *  lives in one place. */
  lifecycle: WorktreeLifecycle;
  /** Initial expected HEAD SHA for the integration worktree at run start.
   *  This is the SHA the integration worktree was checked out at by
   *  `git worktree add` in Step 2 of the pipeline. Subsequent merges
   *  advance the expectation to the post-merge HEAD. */
  initialFeatureBranchSha: string;
}

export interface MergeableTask {
  /** Stable task identifier from the plan. */
  task_id: string;
  /** Base SHA captured at task dispatch (immutable per `task.completed`). */
  base_sha: string;
  /** Tip SHA captured when the subagent exited (immutable per
   *  `task.completed`). */
  task_branch_tip_sha: string;
  /** Branch name — diagnostic only. The cherry-pick uses commit SHAs, not
   *  the branch name. */
  task_branch_name: string;
}

export type MergeResult =
  | {
      status: 'merged';
      feature_branch_sha_after_merge: string;
    }
  | {
      status: 'conflict';
      conflict_report_path: string;
      conflicting_paths: string[];
    }
  | {
      status: 'aborted';
      reason: string;
      precondition_violated: string;
    };

export interface MergeOrchestrator {
  /** Called by the scheduler when a task transitions completed → eligible.
   *  Returns once the merge has settled (success, conflict, or abort). */
  mergeTask(task: MergeableTask): Promise<MergeResult>;
  /** Most recent feature-branch HEAD known to the orchestrator. Updated
   *  after every successful merge. Exposed for tests + diagnostics. */
  expectedFeatureBranchSha(): string;
}

/**
 * Adapt a `MergeOrchestrator` into the scheduler's
 * `(input) => Promise<MergeDecision>` callback shape. The scheduler keeps
 * `task.merge_*` event emission inside `mergeTask`; the callback only
 * returns the categorical decision so the scheduler can update its
 * in-memory state machine.
 */
export function toSchedulerCallback(
  orchestrator: MergeOrchestrator,
): (input: {
  taskId: string;
  baseSha: string;
  taskBranchTipSha: string;
  taskBranchName: string;
  commitShas: string[];
}) => Promise<
  | { kind: 'merged' }
  | { kind: 'merge_conflict'; reason: string }
  | { kind: 'merge_aborted'; reason: string }
> {
  return async input => {
    const result = await orchestrator.mergeTask({
      task_id: input.taskId,
      base_sha: input.baseSha,
      task_branch_tip_sha: input.taskBranchTipSha,
      task_branch_name: input.taskBranchName,
    });
    if (result.status === 'merged') return { kind: 'merged' };
    if (result.status === 'conflict') {
      return {
        kind: 'merge_conflict',
        reason: `cherry-pick conflict — see ${result.conflict_report_path}`,
      };
    }
    return { kind: 'merge_aborted', reason: result.reason };
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a merge orchestrator instance. The orchestrator is stateful in one
 * narrow sense — it remembers the SHA the integration worktree was on after
 * the last successful merge, so the next precondition check can verify the
 * tree wasn't tampered with between merges.
 */
export function createMergeOrchestrator(
  opts: MergeOrchestratorOptions,
): MergeOrchestrator {
  // Validate inputs up front so we fail loudly rather than producing
  // hard-to-debug runtime errors deep inside a git command.
  if (!path.isAbsolute(opts.integrationWorktreePath)) {
    throw new GuardrailError(
      `integrationWorktreePath must be absolute (got "${opts.integrationWorktreePath}")`,
      {
        code: 'invalid_config',
        provider: 'merge-orchestrator',
        details: { integrationWorktreePath: opts.integrationWorktreePath },
      },
    );
  }
  if (!path.isAbsolute(opts.runStateDir)) {
    throw new GuardrailError(
      `runStateDir must be absolute (got "${opts.runStateDir}")`,
      {
        code: 'invalid_config',
        provider: 'merge-orchestrator',
        details: { runStateDir: opts.runStateDir },
      },
    );
  }
  if (!path.isAbsolute(opts.repoLockPath)) {
    throw new GuardrailError(
      `repoLockPath must be absolute (got "${opts.repoLockPath}")`,
      {
        code: 'invalid_config',
        provider: 'merge-orchestrator',
        details: { repoLockPath: opts.repoLockPath },
      },
    );
  }
  if (!isLikelySha(opts.initialFeatureBranchSha)) {
    throw new GuardrailError(
      `initialFeatureBranchSha must be a 40-char hex SHA (got "${opts.initialFeatureBranchSha}")`,
      {
        code: 'invalid_config',
        provider: 'merge-orchestrator',
        details: { initialFeatureBranchSha: opts.initialFeatureBranchSha },
      },
    );
  }
  // Codex pass 2 WARNING: runId is spliced into the expected branch name
  // (`autopilot/<runId>/<taskId>`) used for `git branch -D` during cleanup.
  // Validate at factory time with the same rules as task_id so a malformed
  // runId fails loudly here rather than producing surprising cleanup
  // behaviour later.
  const runIdViolation = validateRunId(opts.runId);
  if (runIdViolation) {
    throw new GuardrailError(`merge-orchestrator: ${runIdViolation}`, {
      code: 'invalid_config',
      provider: 'merge-orchestrator',
      details: { runId: opts.runId },
    });
  }

  let expectedHead = opts.initialFeatureBranchSha;

  // Lock ordering: ALWAYS `withRepoLock` (Layer 2 cross-process) BEFORE
  // `gitQueue.enqueue` (Layer 1 in-process). This matches the scheduler's
  // `worktree-lifecycle.createTaskWorktree` path in PR4, which also takes
  // the repo lock first and then enters the queue. Flipping the order
  // anywhere in the codebase would create classical lock-ordering deadlock:
  // (A holds repo-lock → waits for queue; B holds queue slot → waits for
  // repo-lock). The convention is enforced by code review + this comment.
  const mergeTask = async (task: MergeableTask): Promise<MergeResult> => {
    // (0) Trust-boundary validation. `MergeableTask` is supplied by the
    // scheduler, but the scheduler in turn populates it from the
    // `task.completed` event whose origin is the parsed plan + subagent.
    // Both are caller-influenced, so we validate before any string is
    // spliced into a path, ref, or filename.
    const taskIdViolation = validateTaskId(task.task_id);
    if (taskIdViolation) {
      const failure: PreconditionFailure = {
        precondition: 'invalid_task_id',
        reason: taskIdViolation,
      };
      await emitMergeAborted(opts, task, failure);
      return {
        status: 'aborted',
        reason: failure.reason,
        precondition_violated: failure.precondition,
      };
    }
    const baseShaViolation = validateSha(task.base_sha, 'base_sha');
    if (baseShaViolation) {
      const failure: PreconditionFailure = {
        precondition: 'invalid_base_sha',
        reason: baseShaViolation,
      };
      await emitMergeAborted(opts, task, failure);
      return {
        status: 'aborted',
        reason: failure.reason,
        precondition_violated: failure.precondition,
      };
    }
    const tipShaViolation = validateSha(
      task.task_branch_tip_sha,
      'task_branch_tip_sha',
    );
    if (tipShaViolation) {
      const failure: PreconditionFailure = {
        precondition: 'invalid_tip_sha',
        reason: tipShaViolation,
      };
      await emitMergeAborted(opts, task, failure);
      return {
        status: 'aborted',
        reason: failure.reason,
        precondition_violated: failure.precondition,
      };
    }
    const expectedBranchName = `autopilot/${opts.runId}/${task.task_id}`;
    if (task.task_branch_name !== expectedBranchName) {
      // The branch name is "diagnostic only" for the cherry-pick (we use
      // SHAs), but it IS the argument to `git branch -D` during cleanup.
      // Refuse to delete any branch that isn't the well-known autopilot/
      // namespace for this run+task — otherwise a malformed event could
      // direct the cleanup at `main`, `feature/...`, or another branch.
      const failure: PreconditionFailure = {
        precondition: 'invalid_branch_name',
        reason: `task_branch_name ${quoteSafe(task.task_branch_name)} does not match expected ${quoteSafe(expectedBranchName)}`,
      };
      await emitMergeAborted(opts, task, failure);
      return {
        status: 'aborted',
        reason: failure.reason,
        precondition_violated: failure.precondition,
      };
    }

    return withRepoLock(
      {
        lockPath: opts.repoLockPath,
        command: 'merge-orchestrator',
        run_id: opts.runId,
      },
      () =>
        opts.gitQueue.enqueue(async () => {
          // (1) Preconditions
          const preconditionFailure = checkPreconditions({
            integrationWorktreePath: opts.integrationWorktreePath,
            featureBranch: opts.featureBranch,
            expectedHead,
          });
          if (preconditionFailure) {
            await emitMergeAborted(opts, task, preconditionFailure);
            return {
              status: 'aborted',
              reason: preconditionFailure.reason,
              precondition_violated: preconditionFailure.precondition,
            };
          }

          // (2) Re-verify ancestry under the lock.
          if (
            !gitMergeBaseIsAncestor(
              opts.integrationWorktreePath,
              task.base_sha,
              task.task_branch_tip_sha,
            )
          ) {
            const failure: PreconditionFailure = {
              precondition: 'ancestry_violation_at_merge_time',
              reason: `base_sha ${task.base_sha} is not an ancestor of tip_sha ${task.task_branch_tip_sha}`,
            };
            await emitMergeAborted(opts, task, failure);
            return {
              status: 'aborted',
              reason: failure.reason,
              precondition_violated: failure.precondition,
            };
          }

          // (3) Compute commit list — IMMUTABLE SHAs, oldest first.
          const commitShas = gitRevListOrdered(
            opts.integrationWorktreePath,
            task.base_sha,
            task.task_branch_tip_sha,
          );
          if (commitShas.length === 0) {
            const failure: PreconditionFailure = {
              precondition: 'no_commits_at_merge',
              reason: `base_sha..tip_sha range is empty for task ${task.task_id}`,
            };
            await emitMergeAborted(opts, task, failure);
            return {
              status: 'aborted',
              reason: failure.reason,
              precondition_violated: failure.precondition,
            };
          }

          // (4) Cherry-pick. The first arg is the IMMUTABLE SHA list. If
          // anything goes wrong git exits non-zero; we capture diagnostics
          // BEFORE running `--abort` so the working tree state used by the
          // diagnostics matches what the user would see in a real conflict.
          const cherryPick = runGitCapture(opts.integrationWorktreePath, [
            'cherry-pick',
            ...commitShas,
          ]);
          if (cherryPick.exitCode !== 0) {
            // CAPTURE DIAGNOSTICS FIRST.
            const conflicting = captureConflictingPaths(opts.integrationWorktreePath);
            const indexStages = captureIndexStages(opts.integrationWorktreePath);
            const porcelain = capturePorcelain(opts.integrationWorktreePath);
            const reportPath = writeConflictReport({
              runStateDir: opts.runStateDir,
              runId: opts.runId,
              task,
              integrationWorktreePath: opts.integrationWorktreePath,
              conflictingPaths: conflicting,
              indexStages,
              porcelain,
              cherryPickStderr: cherryPick.stderr,
              commitShas,
            });

            // Now (and only now) abort the cherry-pick. If abort fails we
            // surface a warning via the writer — the operator needs to know
            // the integration worktree is in a half-state, but the conflict
            // event itself still carries the diagnostics.
            const abort = runGitCapture(opts.integrationWorktreePath, [
              'cherry-pick',
              '--abort',
            ]);
            if (abort.exitCode !== 0) {
              await opts.writer
                .writeEvent({
                  event: 'run.warning',
                  message: `cherry-pick --abort failed for task ${task.task_id}: ${abort.stderr}`,
                  details: {
                    task_id: task.task_id,
                    integration_worktree: opts.integrationWorktreePath,
                  },
                })
                .catch(() => undefined);
            }

            await opts.writer.writeEvent({
              event: 'task.merge_conflict',
              task_id: task.task_id,
              conflicting_paths: conflicting,
              index_stages: indexStages,
              porcelain,
              conflict_report_path: reportPath,
            });

            return {
              status: 'conflict',
              conflict_report_path: reportPath,
              conflicting_paths: conflicting,
            };
          }

          // (5) Success — record the new HEAD and emit `task.merged`.
          const newHead = gitRevParseHead(opts.integrationWorktreePath);
          if (!isLikelySha(newHead)) {
            // Defensive: rev-parse should always return a 40-char SHA on
            // success; if it doesn't, treat as an adapter bug rather than
            // silently advancing `expectedHead` to a junk value.
            throw new GuardrailError(
              `rev-parse HEAD returned unexpected value after merge of task ${task.task_id}: "${newHead}"`,
              {
                code: 'adapter_bug',
                provider: 'merge-orchestrator',
                details: { task_id: task.task_id, head_output: newHead },
              },
            );
          }
          expectedHead = newHead;

          await opts.writer.writeEvent({
            event: 'task.merged',
            task_id: task.task_id,
            feature_branch_sha_after_merge: newHead,
            merged_at: new Date().toISOString(),
          });

          // (6) Cleanup. The lifecycle helper handles `git worktree remove
          // --force` + `git branch -D`. We bypass its internal gitQueue by
          // entering it from inside our enqueue() — both helpers share the
          // same queue singleton, so calling lifecycle.cleanupTaskWorktree
          // here would deadlock (it would re-enter the queue we're already
          // inside). We call its underlying git ops directly instead.
          cleanupMergedTaskInline({
            integrationWorktreePath: opts.integrationWorktreePath,
            taskWorktreePath: opts.lifecycle.worktreePathFor(task.task_id),
            taskBranchName: task.task_branch_name,
            writer: opts.writer,
            taskId: task.task_id,
          });

          return {
            status: 'merged',
            feature_branch_sha_after_merge: newHead,
          };
        }),
    );
  };

  return {
    mergeTask,
    expectedFeatureBranchSha: () => expectedHead,
  };
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

interface PreconditionFailure {
  precondition: string;
  reason: string;
}

function checkPreconditions(args: {
  integrationWorktreePath: string;
  featureBranch: string;
  expectedHead: string;
}): PreconditionFailure | null {
  const { integrationWorktreePath, featureBranch, expectedHead } = args;

  if (!fs.existsSync(integrationWorktreePath)) {
    return {
      precondition: 'integration_worktree_missing',
      reason: `integration worktree path does not exist: ${integrationWorktreePath} — was the worktree set up via worktree-lifecycle?`,
    };
  }

  // HEAD on featureBranch?
  let currentBranch: string;
  try {
    currentBranch = runGitOrThrow(integrationWorktreePath, [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]).trim();
  } catch (err) {
    return {
      precondition: 'head_unresolvable',
      reason: `failed to resolve HEAD in integration worktree: ${(err as Error).message}`,
    };
  }
  if (currentBranch !== featureBranch) {
    return {
      precondition: 'wrong_head_branch',
      reason: `integration worktree HEAD is on "${currentBranch}", expected "${featureBranch}"`,
    };
  }

  // HEAD SHA matches expected?
  let actualHead: string;
  try {
    actualHead = runGitOrThrow(integrationWorktreePath, ['rev-parse', 'HEAD']).trim();
  } catch (err) {
    return {
      precondition: 'head_unresolvable',
      reason: `failed to resolve HEAD SHA: ${(err as Error).message}`,
    };
  }
  if (actualHead !== expectedHead) {
    return {
      precondition: 'head_sha_mismatch',
      reason: `integration worktree HEAD ${actualHead} does not match expected ${expectedHead}`,
    };
  }

  // Working tree clean?
  let porcelain: string;
  try {
    porcelain = runGitOrThrow(integrationWorktreePath, [
      'status',
      '--porcelain',
    ]);
  } catch (err) {
    return {
      precondition: 'status_unresolvable',
      reason: `failed to query git status: ${(err as Error).message}`,
    };
  }
  if (porcelain.trim().length > 0) {
    return {
      precondition: 'dirty_tree',
      reason: `integration worktree has uncommitted changes:\n${porcelain.trim()}`,
    };
  }

  // No in-progress merge/rebase/cherry-pick? Worktree-local refs live under
  // `.git/worktrees/<name>/` for linked worktrees, so `rev-parse --git-path`
  // gives us the right location regardless of whether the integration
  // worktree is the primary or a linked checkout.
  const inProgressMarkers = [
    'MERGE_HEAD',
    'REBASE_HEAD',
    'CHERRY_PICK_HEAD',
    // Interactive/merge rebases create a directory rather than a file —
    // check for either flavor.
    'rebase-merge',
    'rebase-apply',
  ];
  for (const marker of inProgressMarkers) {
    let markerPath: string;
    try {
      markerPath = runGitOrThrow(integrationWorktreePath, [
        'rev-parse',
        '--git-path',
        marker,
      ]).trim();
    } catch {
      // rev-parse --git-path always succeeds when git is healthy; if it
      // throws we treat that as "marker not present" rather than failing
      // the precondition check on a tooling glitch.
      continue;
    }
    if (markerPath.length === 0) continue;
    const resolved = path.isAbsolute(markerPath)
      ? markerPath
      : path.resolve(integrationWorktreePath, markerPath);
    if (fs.existsSync(resolved)) {
      return {
        precondition: `in_progress_${marker.toLowerCase()}`,
        reason: `integration worktree has an in-progress operation: ${marker} (${resolved})`,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Event emitters
// ---------------------------------------------------------------------------

async function emitMergeAborted(
  opts: MergeOrchestratorOptions,
  task: MergeableTask,
  failure: PreconditionFailure,
): Promise<void> {
  await opts.writer.writeEvent({
    event: 'task.merge_aborted',
    task_id: task.task_id,
    reason: failure.reason,
    precondition_violated: failure.precondition,
    occurred_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Conflict diagnostics
// ---------------------------------------------------------------------------

function captureConflictingPaths(integrationWorktreePath: string): string[] {
  const out = runGitCapture(integrationWorktreePath, [
    'diff',
    '--name-only',
    '--diff-filter=U',
  ]);
  return out.stdout
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function captureIndexStages(integrationWorktreePath: string): string[] {
  const out = runGitCapture(integrationWorktreePath, ['ls-files', '-u']);
  return out.stdout
    .split('\n')
    .filter(line => line.length > 0);
}

function capturePorcelain(integrationWorktreePath: string): string {
  const out = runGitCapture(integrationWorktreePath, ['status', '--porcelain']);
  return out.stdout;
}

function writeConflictReport(args: {
  runStateDir: string;
  runId: string;
  task: MergeableTask;
  integrationWorktreePath: string;
  conflictingPaths: string[];
  indexStages: string[];
  porcelain: string;
  cherryPickStderr: string;
  commitShas: string[];
}): string {
  // task_id has been pre-validated by `validateTaskId` at the top of
  // mergeTask, but we belt-and-braces here too: resolve the final report
  // path and assert it remains UNDER the conflicts dir. A defence-in-depth
  // check against a future regression that drops the upstream validator.
  const conflictsDir = path.resolve(args.runStateDir, 'conflicts');
  fs.mkdirSync(conflictsDir, { recursive: true });
  const reportPath = path.resolve(conflictsDir, `${args.task.task_id}.md`);
  if (!reportPath.startsWith(conflictsDir + path.sep)) {
    throw new GuardrailError(
      `conflict report path escaped conflicts dir: ${reportPath}`,
      {
        code: 'user_input',
        provider: 'merge-orchestrator',
        details: {
          task_id: args.task.task_id,
          report_path: reportPath,
          conflicts_dir: conflictsDir,
        },
      },
    );
  }
  const conflictingList =
    args.conflictingPaths.length > 0
      ? args.conflictingPaths.map(p => `- ${p}`).join('\n')
      : '_(none reported by `git diff --name-only --diff-filter=U`)_';
  const body = [
    `# Cherry-pick conflict — task ${args.task.task_id}`,
    '',
    `**Run:** ${args.runId}`,
    `**Task:** ${args.task.task_id} (\`${args.task.task_branch_name}\`)`,
    `**Base SHA:** ${args.task.base_sha}`,
    `**Tip SHA:** ${args.task.task_branch_tip_sha}`,
    `**Captured:** ${new Date().toISOString()}`,
    '',
    '## Conflicting paths',
    '',
    conflictingList,
    '',
    '## Index stages (git ls-files -u)',
    '',
    '```',
    args.indexStages.join('\n') || '_(empty)_',
    '```',
    '',
    '## Working tree state (git status --porcelain)',
    '',
    '```',
    args.porcelain.trim() || '_(clean)_',
    '```',
    '',
    '## Cherry-pick stderr',
    '',
    '```',
    args.cherryPickStderr.trim() || '_(empty)_',
    '```',
    '',
    '## Commits attempted',
    '',
    args.commitShas.map(s => `- ${s}`).join('\n'),
    '',
    '## How to resolve',
    '',
    `1. \`cd ${args.integrationWorktreePath}\``,
    `2. Re-run the merge: \`git cherry-pick ${args.commitShas.join(' ')}\``,
    '3. Manually resolve conflicts in the listed paths.',
    '4. Continue: `git cherry-pick --continue`',
    '',
    'OR',
    '',
    `- Add an explicit \`depends_on:\` annotation to the plan for task ${args.task.task_id}, then re-run autopilot.`,
    '',
  ].join('\n');
  fs.writeFileSync(reportPath, body, 'utf8');
  return reportPath;
}

// ---------------------------------------------------------------------------
// Post-merge cleanup (inline — we're already inside gitQueue.enqueue, so we
// cannot call lifecycle.cleanupTaskWorktree without deadlocking).
// ---------------------------------------------------------------------------

function cleanupMergedTaskInline(args: {
  integrationWorktreePath: string;
  taskWorktreePath: string;
  taskBranchName: string;
  writer: SerializedWriter;
  taskId: string;
}): void {
  // `git worktree remove --force` discards any untracked / dirty state in the
  // task worktree. We accept that — the subagent's commits have just been
  // cherry-picked onto the feature branch, so the only thing being lost is
  // ephemeral scratch.
  const removeResult = runGitCapture(args.integrationWorktreePath, [
    'worktree',
    'remove',
    '--force',
    args.taskWorktreePath,
  ]);
  if (removeResult.exitCode !== 0) {
    // Surface a warning but don't fail the merge — the merge itself succeeded
    // and the leftover worktree is recoverable via `runs cleanup`. Use the
    // writer's fire-and-forget pattern.
    args.writer
      .writeEvent({
        event: 'run.warning',
        message: `worktree remove failed for merged task ${args.taskId}: ${removeResult.stderr}`,
        details: {
          task_id: args.taskId,
          task_worktree_path: args.taskWorktreePath,
        },
      })
      .catch(() => undefined);
  }

  const branchResult = runGitCapture(args.integrationWorktreePath, [
    'branch',
    '-D',
    args.taskBranchName,
  ]);
  if (branchResult.exitCode !== 0) {
    // `git worktree remove` may have already deleted the branch, in which
    // case `branch -D` fails harmlessly. Only warn if the error looks
    // genuine — silence the "branch not found" no-op.
    const stderr = branchResult.stderr.toLowerCase();
    const isBenign =
      stderr.includes('not found') ||
      stderr.includes('no such branch') ||
      stderr.includes("isn't a valid branch");
    if (!isBenign) {
      args.writer
        .writeEvent({
          event: 'run.warning',
          message: `branch delete failed for merged task ${args.taskId}: ${branchResult.stderr}`,
          details: {
            task_id: args.taskId,
            branch: args.taskBranchName,
          },
        })
        .catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Git command helpers (synchronous, mirroring worktree-lifecycle.ts patterns)
// ---------------------------------------------------------------------------

interface GitCaptureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `git -C <integration> <args...>` and capture stdout/stderr without
 * throwing on non-zero exit. Used for cherry-pick + diagnostic captures
 * where a non-zero exit is an expected outcome we want to inspect.
 */
function runGitCapture(integrationWorktreePath: string, args: string[]): GitCaptureResult {
  try {
    const stdout = execFileSync(
      'git',
      ['-C', integrationWorktreePath, ...args],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      },
    ).toString();
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    const status = (err as { status?: number | null }).status ?? 1;
    const stdoutBuf = (err as { stdout?: Buffer | string }).stdout;
    const stderrBuf = (err as { stderr?: Buffer | string }).stderr;
    const stdout = stdoutBuf
      ? Buffer.isBuffer(stdoutBuf)
        ? stdoutBuf.toString('utf8')
        : String(stdoutBuf)
      : '';
    const stderr = stderrBuf
      ? Buffer.isBuffer(stderrBuf)
        ? stderrBuf.toString('utf8')
        : String(stderrBuf)
      : (err as Error).message;
    return { exitCode: status, stdout, stderr };
  }
}

/**
 * Run `git -C <integration> <args...>` synchronously. Throws GuardrailError
 * on non-zero exit. Used for queries where any non-zero exit is a hard
 * failure we surface to the caller.
 */
function runGitOrThrow(integrationWorktreePath: string, args: string[]): string {
  const result = runGitCapture(integrationWorktreePath, args);
  if (result.exitCode !== 0) {
    throw new GuardrailError(
      `git ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      {
        code: 'adapter_bug',
        provider: 'merge-orchestrator',
        details: {
          args,
          cwd: integrationWorktreePath,
          exit_code: result.exitCode,
          stderr: result.stderr,
        },
      },
    );
  }
  return result.stdout;
}

/** Resolve HEAD in the integration worktree to its full 40-char SHA. */
function gitRevParseHead(integrationWorktreePath: string): string {
  return runGitOrThrow(integrationWorktreePath, ['rev-parse', 'HEAD']).trim();
}

/**
 * `git merge-base --is-ancestor` returns 0 if true, 1 if false, throws
 * otherwise. We treat exit 1 as a documented "no" and any other non-zero
 * exit as a tooling failure.
 */
function gitMergeBaseIsAncestor(
  integrationWorktreePath: string,
  ancestor: string,
  descendant: string,
): boolean {
  const result = runGitCapture(integrationWorktreePath, [
    'merge-base',
    '--is-ancestor',
    ancestor,
    descendant,
  ]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new GuardrailError(
    `git merge-base --is-ancestor failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    {
      code: 'adapter_bug',
      provider: 'merge-orchestrator',
      details: {
        ancestor,
        descendant,
        exit_code: result.exitCode,
        stderr: result.stderr,
      },
    },
  );
}

/** Ordered commit SHAs (oldest first) in `base..tip`. */
function gitRevListOrdered(
  integrationWorktreePath: string,
  baseSha: string,
  tipSha: string,
): string[] {
  const out = runGitOrThrow(integrationWorktreePath, [
    'rev-list',
    '--reverse',
    `${baseSha}..${tipSha}`,
  ]);
  return out
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/** Quick check that a string looks like a 40-char hex SHA. Used to gate
 *  the post-merge expectedHead update so we don't quietly poison subsequent
 *  precondition checks with a junk value. */
function isLikelySha(s: string): boolean {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
}

/**
 * Strict allowlist for task IDs spliced into filesystem paths (conflict
 * report) and git refs (cleanup branch name). Mirrors the worktree-lifecycle
 * regex — ASCII alphanumerics, `.`, `_`, `-`; 1..80 chars; must start with
 * alphanumeric. Rejects `../`, absolute paths, ref tricks, shell metachars,
 * and `.lock` suffixes.
 *
 * On top of the regex, applies git's own ref-format rules to reject the
 * subset of strings that pass the regex but git itself disallows:
 *   - `..` anywhere (git refuses double-dot for refs)
 *   - trailing `.` (git refuses ref components ending in `.`)
 *   - leading `.` (already excluded by the regex but covered here too)
 *   - `@{` (git uses `@{...}` for reflog refs)
 *
 * Returns null on success, an error message string on rejection.
 */
const SAFE_TASK_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
function validateTaskId(taskId: unknown): string | null {
  if (typeof taskId !== 'string' || !SAFE_TASK_ID_RE.test(taskId)) {
    return `task_id ${quoteSafe(taskId)} is unsafe — must match ${SAFE_TASK_ID_RE.source}`;
  }
  if (taskId.endsWith('.lock')) {
    return `task_id ${quoteSafe(taskId)} cannot end with .lock (git ref restriction)`;
  }
  // Git ref-format rules that the regex doesn't catch.
  if (taskId.includes('..')) {
    return `task_id ${quoteSafe(taskId)} cannot contain ".." (git ref restriction)`;
  }
  if (taskId.endsWith('.')) {
    return `task_id ${quoteSafe(taskId)} cannot end with "." (git ref restriction)`;
  }
  if (taskId.includes('@{')) {
    return `task_id ${quoteSafe(taskId)} cannot contain "@{" (git ref restriction)`;
  }
  return null;
}

/**
 * Validate `runId` with the same strict allowlist as `task_id` plus the
 * same git-ref-format rules. The runId is spliced into the branch name
 * (`autopilot/<runId>/<taskId>`) and the conflict-report path, so an
 * unvalidated runId would re-introduce the very class of bugs we fixed
 * for task_id.
 */
function validateRunId(runId: unknown): string | null {
  return validateTaskId(runId)?.replace('task_id', 'run_id') ?? null;
}

/**
 * Validate that a string is a 40-char lowercase hex SHA. Returns null on
 * success, a human-readable error string on rejection. Used for
 * `MergeableTask.base_sha` and `task_branch_tip_sha` so a malformed event
 * cannot pass garbage to `git rev-list` / `git merge-base`.
 */
function validateSha(value: unknown, fieldName: string): string | null {
  if (typeof value !== 'string') {
    return `${fieldName} must be a string (got ${typeof value})`;
  }
  if (!/^[0-9a-f]{40}$/.test(value)) {
    return `${fieldName} ${quoteSafe(value)} is not a 40-char lowercase hex SHA`;
  }
  return null;
}

/** Regex matching Unicode bidi-override + zero-width-control characters
 *  that JSON.stringify allows through verbatim. Built dynamically so the
 *  source file itself stays free of invisible chars. */
const BIDI_AND_ZWS_RE = new RegExp(
  '[' +
    '\\u200B-\\u200F' + // ZWSP, ZWNJ, ZWJ, LRM, RLM
    '\\u202A-\\u202E' + // LRE, RLE, PDF, LRO, RLO
    '\\u2066-\\u2069' + // LRI, RLI, FSI, PDI
    ']',
  'g',
);

/**
 * Render an untrusted value as a quoted string suitable for logs / event
 * payloads. Caps length to 200 chars and escapes:
 *   - C0 / C1 control chars (via JSON.stringify's default escaping)
 *   - Unicode bidi format chars (U+202A–U+202E, U+2066–U+2069) — these
 *     visually reorder text in terminals and IDEs and can spoof log
 *     output even though JSON.stringify lets them through verbatim
 *   - Zero-width controls (U+200B–U+200F) — same rationale
 *
 * Codex pass 2 WARNING (raw echo as injection vector) + pass 3 WARNING
 * (JSON.stringify alone misses bidi/format chars).
 */
function quoteSafe(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value);
  const MAX = 200;
  const truncated = raw.length > MAX ? raw.slice(0, MAX) + `…(truncated, len=${raw.length})` : raw;
  // Replace bidi/format/zero-width controls with their \uXXXX escapes
  // BEFORE JSON.stringify, so the final output literally shows the escape
  // sequence rather than the invisible reorder character. Codepoints
  // matched (covers bidi overrides + zero-width controls):
  //   U+200B..U+200F  (ZWSP, ZWNJ, ZWJ, LRM, RLM)
  //   U+202A..U+202E  (LRE, RLE, PDF, LRO, RLO)
  //   U+2066..U+2069  (LRI, RLI, FSI, PDI)
  const sanitised = truncated.replace(
    BIDI_AND_ZWS_RE,
    ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  );
  // JSON.stringify handles C0/C1 control chars and adds the surrounding
  // double-quotes.
  return JSON.stringify(sanitised);
}
