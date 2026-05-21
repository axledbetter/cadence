// src/core/concurrent-dispatch/worktree-lifecycle.ts
//
// Per-task git worktree lifecycle for concurrent subagent dispatch. PR 4 of 6
// of the v7.11.0 concurrent subagent execution spec.
//
// Responsibilities (matched to spec section "Worktree lifecycle (state-based
// cleanup)"):
//
//   1. Setup — create a per-task worktree under
//      `.claude/worktrees/<run-ulid>/<task-id>/`, branched from the integration
//      worktree's current HEAD. The branch is named
//      `autopilot/<run-ulid>/<task-id>`. The HEAD SHA at creation time is the
//      `base_sha` — recorded in `task.started` and used downstream for
//      ancestry validation and `rev-list` no-commits detection.
//
//   2. Ancestry validation — once the subagent exits, verify the task branch
//      tip is a descendant of the recorded `base_sha` via
//      `git merge-base --is-ancestor`. A rewrite (rebase/reset/force-update)
//      that drops the base out of the ancestry chain is treated as an
//      ancestry_violation; the task fails terminally and the commits are NOT
//      cherry-picked.
//
//   3. No-commits detection — `git rev-list --count base..tip == 0` means the
//      subagent did not commit. Treated as a `no_commits` failure.
//
//   4. Cleanup is STATE-BASED (per spec; fix from pass 2/3 inconsistency):
//      ONLY tasks in state `merged` get their worktree + branch removed. Every
//      other terminal state — `failed`, `interrupted`, `completed-but-unmerged`,
//      `timeout`, `merge_conflict`, `ancestry_violation` — keeps the worktree
//      AND branch on disk for the user to inspect / `runs cleanup` later.
//
//   5. Worktree-path-collision check — refuses to create a new worktree if
//      `.claude/worktrees/<run-ulid>/<task-id>/` already exists. The collision
//      typically indicates a prior crash; the error message points the user at
//      `claude-autopilot runs gc` (per spec).
//
// All mutating operations route through the caller's `GitOperationQueue` to
// serialize against other in-process git mutations, and through `withRepoLock`
// to serialize across processes. This module deliberately accepts those as
// constructor arguments rather than instantiating them itself — the scheduler
// owns the lifecycle of both.
//
// Spec: docs/superpowers/specs/2026-05-19-v7.11.0-concurrent-subagent-execution-design.md

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { GuardrailError } from '../errors.ts';
import type { GitOperationQueue } from './git-op-queue.ts';

/** Possible terminal states a task can reach. Only `merged` triggers
 *  worktree+branch removal — every other state preserves the worktree for
 *  inspection (state-based cleanup; spec section "Worktree lifecycle"). */
export type TaskTerminalState =
  | 'merged'
  | 'failed'
  | 'interrupted'
  | 'completed-but-unmerged'
  | 'timeout'
  | 'merge_conflict'
  | 'ancestry_violation';

/** Result of a successful `createTaskWorktree`. Carries the immutable
 *  `base_sha` and the branch + worktree paths so the scheduler can stamp them
 *  onto `task.started` and later events. */
export interface CreatedTaskWorktree {
  /** Absolute path to the worktree dir (under `.claude/worktrees/<run-ulid>/`). */
  worktreePath: string;
  /** Fully-qualified branch name created for this task. */
  branch: string;
  /** Commit SHA that the branch was anchored at — the AUTHORITATIVE reference
   *  for ancestry validation and no-commits detection. */
  baseSha: string;
}

/** Outcome of `verifyTaskCommits` — feeds the scheduler's decision to emit
 *  `task.completed` vs `task.failed`. */
export type CommitVerification =
  | { kind: 'ok'; tipSha: string; commitShas: string[] }
  | { kind: 'no_commits'; tipSha: string }
  | { kind: 'ancestry_violation'; tipSha: string; reason: string };

/** Options bundle for the lifecycle manager. The scheduler owns the queue
 *  and integration worktree path; this module just consumes them. */
export interface WorktreeLifecycleOptions {
  /** Absolute path of the integration worktree (the dedicated checkout of
   *  `feature/<topic-slug>`). All `git worktree add` commands are issued
   *  with `git -C <integrationWorktree>` because worktree management is
   *  per-repo-instance and we want the linkage recorded under the run's
   *  feature checkout. */
  integrationWorktree: string;
  /** Absolute path to `.claude/worktrees/<run-ulid>/`. Per-task worktrees
   *  live as `<runWorktreesDir>/<task-id>/`. The scheduler creates this dir
   *  (and the colocated integration worktree) before starting the loop. */
  runWorktreesDir: string;
  /** Run ULID — encoded into branch names as `autopilot/<runId>/<task-id>`. */
  runId: string;
  /** In-process git mutex. PR 4 expects the scheduler to pass its singleton
   *  in so worktree ops are serialized with cherry-picks (PR 5). */
  gitQueue: GitOperationQueue;
}

/**
 * Manages per-task worktree creation, ancestry validation, and state-based
 * cleanup. One instance per scheduler run.
 *
 * Thread-safety: all mutating methods route through `opts.gitQueue.enqueue`
 * so concurrent callers within one process are serialized. Cross-process
 * serialization is the scheduler's responsibility (via `withRepoLock`).
 */
export class WorktreeLifecycle {
  constructor(private readonly opts: WorktreeLifecycleOptions) {}

  /** Branch name we'll create / clean up for a given task. Exposed so the
   *  scheduler can include it in `task.started` / `task.completed` without
   *  duplicating the convention. */
  branchFor(taskId: string): string {
    return `autopilot/${this.opts.runId}/${taskId}`;
  }

  /** Absolute path of the per-task worktree. */
  worktreePathFor(taskId: string): string {
    return path.join(this.opts.runWorktreesDir, taskId);
  }

  /**
   * Create a per-task worktree branched from the integration worktree's
   * current HEAD. Refuses if the target directory already exists (the spec's
   * collision-refusal contract — likely a crashed prior run; user must
   * `runs gc`). Captures and returns the `base_sha`.
   *
   * The caller is expected to have already taken the cross-process repo
   * lock; this method only adds the in-process serialization via gitQueue.
   */
  async createTaskWorktree(taskId: string): Promise<CreatedTaskWorktree> {
    const worktreePath = this.worktreePathFor(taskId);
    const branch = this.branchFor(taskId);

    return this.opts.gitQueue.enqueue(async () => {
      // Collision refusal — `.claude/worktrees/<run-ulid>/<task-id>/` must
      // not exist. Either a crashed prior run left it, or two scheduler
      // instances are racing (which should be impossible if the per-run
      // lock works). Surface with a recovery hint.
      if (fs.existsSync(worktreePath)) {
        throw new GuardrailError(
          `worktree path already exists: ${worktreePath} — likely a crashed prior run; clear via 'claude-autopilot runs gc'`,
          {
            code: 'concurrency_lock',
            provider: 'concurrent-dispatch',
            details: {
              task_id: taskId,
              worktree_path: worktreePath,
              recovery: 'claude-autopilot runs gc --older-than-days 0',
            },
          },
        );
      }

      // Capture the integration worktree's HEAD before creating the new
      // worktree. This is the IMMUTABLE base_sha that downstream ancestry
      // and no-commits checks compare against.
      const baseSha = this.gitRevParseHead();

      // Ensure parent dir exists. `git worktree add` will create the
      // worktree dir itself.
      fs.mkdirSync(this.opts.runWorktreesDir, { recursive: true });

      // git worktree add <path> -b <branch> <base_sha>
      // -b creates the branch atomically with the worktree linkage so a
      // crash between branch creation and worktree dir creation cannot
      // leak a half-created state.
      this.gitRun([
        'worktree',
        'add',
        worktreePath,
        '-b',
        branch,
        baseSha,
      ]);

      return { worktreePath, branch, baseSha };
    });
  }

  /**
   * Verify the task branch's tip is a descendant of the recorded base_sha,
   * count commits, and return the ordered commit list. The scheduler maps
   * the verification result onto `task.completed` (kind 'ok') or
   * `task.failed` (kinds 'no_commits' / 'ancestry_violation').
   *
   * Subtle ordering: we deliberately call `merge-base --is-ancestor` BEFORE
   * `rev-list --count` because an ancestry violation has different semantics
   * from a no-commits case. A subagent that rebased its branch off a
   * different base could still produce `rev-list base..tip > 0` (the
   * commits look like new commits to git's reachability check), but the
   * cherry-picks would never have a clean starting point on the integration
   * branch. Surfacing as `ancestry_violation` lets PR 5 (merge orchestrator)
   * refuse the cherry-pick chain explicitly rather than failing in the
   * middle.
   */
  async verifyTaskCommits(taskId: string, baseSha: string): Promise<CommitVerification> {
    return this.opts.gitQueue.enqueue(async () => {
      const branch = this.branchFor(taskId);

      // 1. Resolve the branch tip. `rev-parse` returns the SHA; if the
      // branch was somehow deleted out from under us, surface as
      // ancestry_violation rather than crashing — the absent branch IS
      // a contract violation by the subagent.
      let tipSha: string;
      try {
        tipSha = this.gitRevParse(branch);
      } catch (err) {
        return {
          kind: 'ancestry_violation',
          tipSha: 'unknown',
          reason: `task branch ${branch} not resolvable: ${(err as Error).message}`,
        };
      }

      // 2. Ancestry check — `merge-base --is-ancestor A B` exits 0 if A is
      // an ancestor of B (or equal), 1 otherwise. We invoke via execFileSync
      // and catch the non-zero exit explicitly.
      const isAncestor = this.gitMergeBaseIsAncestor(baseSha, tipSha);
      if (!isAncestor) {
        return {
          kind: 'ancestry_violation',
          tipSha,
          reason: `base_sha ${baseSha} is not an ancestor of task branch tip ${tipSha} — branch was rebased/reset/force-updated`,
        };
      }

      // 3. No-commits detection — `rev-list --count base..tip == 0`.
      const count = this.gitRevListCount(baseSha, tipSha);
      if (count === 0) {
        return { kind: 'no_commits', tipSha };
      }

      // 4. Ordered commit SHAs (oldest first, via --reverse). Stored on
      // `task.completed.commit_shas` so the merge orchestrator can
      // cherry-pick in the right order.
      const commitShas = this.gitRevListOrdered(baseSha, tipSha);

      return { kind: 'ok', tipSha, commitShas };
    });
  }

  /**
   * State-based cleanup. Per spec: ONLY `merged` triggers worktree + branch
   * removal. Every other terminal state preserves the worktree on disk for
   * `runs cleanup` to handle interactively.
   *
   * For preserved states we drop a small status file at the worktree root
   * (`.autopilot-state.json`) so `runs cleanup` can describe what each
   * leftover worktree is. The state file is the only WRITE this function
   * performs in the preserved branches; the subagent's contents are
   * untouched.
   */
  async cleanupTaskWorktree(taskId: string, state: TaskTerminalState): Promise<void> {
    const worktreePath = this.worktreePathFor(taskId);
    const branch = this.branchFor(taskId);

    return this.opts.gitQueue.enqueue(async () => {
      if (state === 'merged') {
        // Successful merge: remove the worktree linkage AND delete the
        // branch. Use --force on worktree remove to discard any untracked
        // files (the subagent's commits have already been cherry-picked
        // into the integration branch).
        try {
          this.gitRun(['worktree', 'remove', '--force', worktreePath]);
        } catch (err) {
          // Best-effort — the worktree linkage might already be gone (e.g.
          // the subagent or a test fixture cleared it). We still try to
          // delete the branch below. Surface via run.warning if needed —
          // but log the cause to GuardrailError details for diagnostics.
          throw new GuardrailError(
            `worktree remove failed for task ${taskId}: ${(err as Error).message}`,
            {
              code: 'adapter_bug',
              provider: 'concurrent-dispatch',
              details: { task_id: taskId, worktree_path: worktreePath },
            },
          );
        }

        // Delete the branch. -D (uppercase) forces deletion even if the
        // branch is not fully merged into the upstream's @{upstream} —
        // which it won't be, because the cherry-pick chain landed
        // different SHAs on the integration branch. Without -D the
        // cleanup would loop on every successful merge.
        try {
          this.gitRun(['branch', '-D', branch]);
        } catch {
          // Branch may have been deleted by the worktree remove already.
          // Idempotent: silently swallow.
        }
        return;
      }

      // Preserved state: drop a marker file so `runs cleanup` knows what
      // this leftover is. We don't fail if writing the marker fails (the
      // worktree is still inspectable; the marker is a convenience).
      try {
        if (fs.existsSync(worktreePath)) {
          const markerPath = path.join(worktreePath, '.autopilot-state.json');
          const marker = {
            task_id: taskId,
            run_id: this.opts.runId,
            terminal_state: state,
            branch,
            preserved_at: new Date().toISOString(),
          };
          fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8');
        }
      } catch {
        // intentionally swallowed — preservation is best-effort
      }
    });
  }

  // --------------------------------------------------------------------------
  // Internal: git command runners. Synchronous via execFileSync (matches the
  // pattern in `src/core/shell.ts`); the calls are serialized by gitQueue so
  // we don't need an async child_process surface. Errors are translated into
  // GuardrailError so the scheduler can surface them uniformly.
  // --------------------------------------------------------------------------

  /** Run `git -C <integrationWorktree> <args...>` synchronously. Throws on
   *  non-zero exit. Used for write operations + ancestry checks. */
  private gitRun(args: string[]): string {
    try {
      return execFileSync('git', ['-C', this.opts.integrationWorktree, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      }).toString();
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new GuardrailError(
        `git ${args.join(' ')} failed: ${cause}`,
        {
          code: 'adapter_bug',
          provider: 'concurrent-dispatch',
          details: { args, cause, cwd: this.opts.integrationWorktree },
        },
      );
    }
  }

  /** Resolve HEAD in the integration worktree to its full SHA. */
  private gitRevParseHead(): string {
    return this.gitRun(['rev-parse', 'HEAD']).trim();
  }

  /** Resolve an arbitrary ref to a SHA. */
  private gitRevParse(ref: string): string {
    return this.gitRun(['rev-parse', ref]).trim();
  }

  /** Run `git merge-base --is-ancestor <ancestor> <descendant>`. Returns
   *  true on exit 0 (ancestor relationship holds), false on exit 1, and
   *  throws on any other exit (treated as a tooling failure, not a
   *  diagnostic answer). */
  private gitMergeBaseIsAncestor(ancestor: string, descendant: string): boolean {
    try {
      execFileSync(
        'git',
        ['-C', this.opts.integrationWorktree, 'merge-base', '--is-ancestor', ancestor, descendant],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
      );
      return true;
    } catch (err) {
      // execFileSync surfaces exit code on err.status.
      const status = (err as { status?: number | null }).status;
      if (status === 1) {
        // Documented exit code: ancestor relationship does NOT hold.
        return false;
      }
      // Other exits (128 = bad SHA, 129 = bad args) are tooling failures.
      const cause = err instanceof Error ? err.message : String(err);
      throw new GuardrailError(
        `git merge-base --is-ancestor failed (status=${String(status)}): ${cause}`,
        {
          code: 'adapter_bug',
          provider: 'concurrent-dispatch',
          details: { ancestor, descendant, status, cause },
        },
      );
    }
  }

  /** Count commits reachable from `tip` but not from `base`. */
  private gitRevListCount(baseSha: string, tipSha: string): number {
    const out = this.gitRun(['rev-list', '--count', `${baseSha}..${tipSha}`]).trim();
    const n = Number.parseInt(out, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new GuardrailError(
        `git rev-list --count returned non-numeric output: ${out}`,
        {
          code: 'adapter_bug',
          provider: 'concurrent-dispatch',
          details: { baseSha, tipSha, output: out },
        },
      );
    }
    return n;
  }

  /** Ordered commit SHAs (oldest first) in `base..tip`. */
  private gitRevListOrdered(baseSha: string, tipSha: string): string[] {
    const out = this.gitRun(['rev-list', '--reverse', `${baseSha}..${tipSha}`]);
    return out
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }
}

/**
 * Refuse to start a run if `.claude/worktrees/<run-ulid>/` already exists.
 * Per spec: "the scheduler refuses to start until claude-autopilot runs gc
 * --older-than-days 0 clears it". The scheduler calls this at startup BEFORE
 * any worktree work.
 *
 * We treat the existence of EITHER the run dir itself OR a non-empty content
 * within it as a collision. An empty parent (e.g. fresh test fixture that
 * created it) is allowed.
 */
export function assertRunWorktreesDirAvailable(runWorktreesDir: string): void {
  if (!fs.existsSync(runWorktreesDir)) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(runWorktreesDir);
  } catch {
    entries = [];
  }
  if (entries.length === 0) return;
  throw new GuardrailError(
    `run worktrees directory already populated: ${runWorktreesDir} — likely a crashed prior run; clear via 'claude-autopilot runs gc --older-than-days 0'`,
    {
      code: 'concurrency_lock',
      provider: 'concurrent-dispatch',
      details: {
        run_worktrees_dir: runWorktreesDir,
        existing_entries: entries.slice(0, 10),
        recovery: 'claude-autopilot runs gc --older-than-days 0',
      },
    },
  );
}
