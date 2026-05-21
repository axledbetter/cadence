// src/core/concurrent-dispatch/scheduler.ts
//
// Concurrent subagent dispatch loop for v7.11.0. PR 4 of 6.
//
// Responsibilities:
//
//   1. Walk the `DepGraph`, dispatching tasks whose dependencies are all in
//      state `merged` (NOT just `completed` — see spec CRITICAL #1 from pass 1;
//      gating on `merged` is the load-bearing correctness invariant).
//
//   2. Respect concurrency caps:
//        effectiveConcurrency = min(
//          config.maxParallelSubagents,        // user-facing knob, schema 1..8
//          providerRateLimitConcurrency,       // injected from provider adapter
//          taskCount,                          // can't dispatch more than there are
//        )
//
//   3. Per-task dispatch chain:
//        a. BudgetReservation.reserve(...) — atomic budget check + event append
//        b. WorktreeLifecycle.createTaskWorktree(...) — git worktree add + base_sha
//        c. emit `task.started` with the immutable base_sha
//        d. invoke the injected `SubagentRunner` with an AbortController + timeout
//        e. on subagent exit:
//             - WorktreeLifecycle.verifyTaskCommits(...) — ancestry + no-commits
//             - emit task.completed (kind 'ok') or task.failed (other kinds)
//        f. on timeout: emit BOTH `task.timeout` (informational) AND
//             `task.failed` (terminal, error_type: 'timeout') per spec —
//             dual-emission ensures resume classification treats it terminally.
//
//   4. PR 4 stops at `task.completed`. The merge orchestrator (PR 5) is what
//      transitions a task to state `merged`. Until then, downstream dependents
//      of a `completed` task remain blocked. If the scheduler reaches a state
//      where everything in-flight has settled but no further task is ready
//      (because dependents are still waiting on `merged`), it halts with a
//      `"X tasks completed but not merged; merge orchestrator (PR5) required"`
//      diagnostic. This makes PR 4 testable in isolation while preserving the
//      eventual contract.
//
//   5. Deadlock detection: if no in-flight tasks, no ready tasks, and remaining
//      tasks have unmet dependencies — and NONE of those dependencies are in a
//      mergeable state PR 5 could resolve — the run halts with a
//      `deadlock_detected` error carrying a state dump.
//
//   6. SIGTERM handling: cancellations send `kill -TERM -<pgid>` to the
//      subagent's process group, then SIGKILL the group after 30s grace. The
//      AbortController wired through to the SubagentRunner is the canonical
//      cancellation signal; the runner is expected to spawn its child detached
//      (creating a new process group whose leader pid matches the child pid)
//      and to react to AbortSignal aborts by killing that group.
//
// All git operations go through the WorktreeLifecycle, which routes them
// through the shared GitOperationQueue. The scheduler additionally wraps the
// per-task worktree creation in `withRepoLock` so cross-process git mutations
// from another `claude-autopilot` invocation block.
//
// Spec: docs/superpowers/specs/2026-05-19-v7.11.0-concurrent-subagent-execution-design.md

import { GuardrailError } from '../errors.ts';
import { withRepoLock } from '../run-state/repo-lock.ts';
import type { SerializedWriter } from '../run-state/serialized-writer.ts';

import type { BudgetReservation, BudgetCaps } from './budget-reservation.ts';
import { BudgetExceededError } from './budget-reservation.ts';
import type { GitOperationQueue } from './git-op-queue.ts';
import type { DepGraph, DispatchResult } from './types.ts';
import {
  WorktreeLifecycle,
  type TaskTerminalState,
  type CommitVerification,
  type CreatedTaskWorktree,
} from './worktree-lifecycle.ts';

// ---------------------------------------------------------------------------
// SubagentRunner interface — injected by the scheduler's caller (and mocked
// by tests). PR 4 deliberately does NOT spawn the real subagent — that's
// PR 6's territory. The contract is small enough to mock cleanly while
// covering every behavior the scheduler needs.
// ---------------------------------------------------------------------------

export interface SubagentRunInput {
  taskId: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
  /** Aborted when the scheduler wants to cancel the subagent. The runner is
   *  expected to translate this to `process.kill(-pgid, 'SIGTERM')` and,
   *  after 30s, `SIGKILL`. */
  signal: AbortSignal;
  /** Hard wall-clock timeout in ms; the scheduler also enforces this via the
   *  AbortController, but passing it through gives the runner an early
   *  warning before the signal fires (useful for graceful shutdown). */
  timeoutMs: number;
}

export interface SubagentRunResult {
  /** Whether the subagent reported success (its commits, if any, will be
   *  validated downstream by WorktreeLifecycle.verifyTaskCommits). */
  exitStatus: 'success' | 'failure';
  /** Actual cost in USD the subagent spent. Used to release the budget
   *  reservation accurately. */
  actualCostUsd: number;
  /** Free-form failure message, surfaced on `task.failed` when exitStatus is
   *  'failure'. */
  errorMessage?: string;
  /** True when the runner detected the signal had aborted and killed the
   *  subagent. The scheduler uses this to decide between `error_type:
   *  'timeout'` (we initiated the abort because the timer fired) and other
   *  failure classifications. */
  aborted?: boolean;
}

/** SubagentRunner is the contract every concrete runner (real or mock)
 *  implements. PR 6 will provide a real implementation; PR 4 ships only the
 *  scheduler that consumes the interface. */
export type SubagentRunner = (input: SubagentRunInput) => Promise<SubagentRunResult>;

// ---------------------------------------------------------------------------
// Scheduler options + result types.
// ---------------------------------------------------------------------------

export interface ConcurrencyConfig {
  /** Default 3; schema range 1..8. The caller is responsible for validating
   *  this at config-load time — the scheduler just trusts the supplied
   *  value. */
  maxParallelSubagents: number;
  /** Hard per-subagent timeout in ms. SIGTERM at this point; SIGKILL after
   *  30s grace. */
  perSubagentTimeoutMs: number;
  /** Provider's reported max concurrent requests for the model. Used to
   *  derive effectiveConcurrency. Optional — if undefined the
   *  maxParallelSubagents knob wins. */
  providerRateLimitConcurrency?: number;
  /** Grace period (ms) between SIGTERM and SIGKILL on cancellation. Default
   *  30_000 per spec. Override only for tests. */
  sigkillGraceMs?: number;
}

export interface SchedulerOptions {
  /** Parsed plan + dep graph from PR 1. */
  graph: DepGraph;
  /** Concurrency / timeout configuration. */
  concurrency: ConcurrencyConfig;
  /** Budget caps to pass to every `BudgetReservation.reserve()` call. */
  budgetCaps: BudgetCaps;
  /** Per-task pre-flight cost estimate function. The scheduler asks the
   *  caller for an estimate at dispatch time rather than baking it into the
   *  plan — the estimator can use plan metadata, prior-run telemetry, or a
   *  flat constant. Default: $1.00 per task. */
  estimatePerTaskUsd?: (taskId: string) => number;
  /** Budget reservation ledger. */
  budget: BudgetReservation;
  /** Per-run event writer. */
  writer: SerializedWriter;
  /** Run ULID. */
  runId: string;
  /** Absolute path to `.claude/worktrees/<run-ulid>/`. The scheduler creates
   *  per-task worktrees as subdirectories. */
  runWorktreesDir: string;
  /** Absolute path to the integration worktree (where merges land). */
  integrationWorktree: string;
  /** Absolute path to the cross-process repo lock file (typically
   *  `.claude/run-state/repo.lock`). */
  repoLockPath: string;
  /** Shared in-process git mutex. */
  gitQueue: GitOperationQueue;
  /** Injected subagent runner. Tests pass a mock; production passes the real
   *  spawn-and-supervise implementation from PR 6. */
  subagentRunner: SubagentRunner;
}

/** Per-task lifecycle state tracked inside the scheduler loop. */
type TaskState =
  | 'pending'
  | 'started'
  | 'completed'
  | 'merged'
  | 'failed'
  | 'timeout'
  | 'ancestry_violation'
  | 'no_commits'
  | 'interrupted';

/** Final state classification — used for state-based cleanup. The
 *  scheduler maps internal TaskState to TaskTerminalState before invoking
 *  `cleanupTaskWorktree`. */
function toTerminalState(state: TaskState): TaskTerminalState {
  switch (state) {
    case 'merged':
      return 'merged';
    case 'timeout':
      return 'timeout';
    case 'ancestry_violation':
      return 'ancestry_violation';
    case 'no_commits':
      return 'failed';
    case 'interrupted':
      return 'interrupted';
    case 'failed':
      return 'failed';
    case 'completed':
      // Scheduler hit "all in-flight settled, nothing to merge here"
      // without PR 5. Spec calls this "completed-but-unmerged".
      return 'completed-but-unmerged';
    default:
      // pending / started shouldn't reach cleanup but if they do, treat
      // as interrupted.
      return 'interrupted';
  }
}

interface TaskRecord {
  taskId: string;
  state: TaskState;
  /** Set once createTaskWorktree resolves. */
  worktree?: CreatedTaskWorktree;
  /** AbortController for the in-flight subagent. */
  abort?: AbortController;
  /** Pending promise from the in-flight subagent. Resolved with the runner's
   *  result; the scheduler treats rejections as 'failure' with the error
   *  message attached. */
  pending?: Promise<void>;
  /** Captured for diagnostics. */
  errorMessage?: string;
  /** Last verification — only set after subagent exit. */
  verification?: CommitVerification;
  /** Actual cost reported by the runner, for budget release accounting. */
  actualCostUsd?: number;
}

export interface SchedulerDiagnostics {
  reason:
    | 'all_tasks_merged'
    | 'stopped_pending_merge_orchestrator'
    | 'deadlock_detected'
    | 'budget_halt'
    | 'task_failed'
    | 'aborted_by_caller';
  detail: string;
  effectiveConcurrency: number;
  states: Record<string, TaskState>;
}

export interface SchedulerResult extends DispatchResult {
  diagnostics: SchedulerDiagnostics;
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

/**
 * Run the concurrent dispatch scheduler to completion (or to a graceful halt
 * when merge orchestrator is needed; see PR 4 module header).
 *
 * This is a single-shot function — one scheduler per run. Callers should NOT
 * re-invoke after it returns; use the run-state engine's resume to pick up
 * from events.ndjson.
 */
export async function runScheduler(opts: SchedulerOptions): Promise<SchedulerResult> {
  // Build the lifecycle helper. Owns its own queue reference; the scheduler
  // shares the same singleton so worktree adds serialize against any future
  // cherry-picks PR 5 enqueues.
  const lifecycle = new WorktreeLifecycle({
    integrationWorktree: opts.integrationWorktree,
    runWorktreesDir: opts.runWorktreesDir,
    runId: opts.runId,
    gitQueue: opts.gitQueue,
  });

  const records = new Map<string, TaskRecord>();
  const allTaskIds = opts.graph.tasks.map(t => t.id);
  for (const id of allTaskIds) {
    records.set(id, { taskId: id, state: 'pending' });
  }

  const effectiveConcurrency = Math.max(
    1,
    Math.min(
      opts.concurrency.maxParallelSubagents,
      opts.concurrency.providerRateLimitConcurrency ?? Number.MAX_SAFE_INTEGER,
      allTaskIds.length || 1,
    ),
  );

  const estimate =
    opts.estimatePerTaskUsd ?? ((_id: string): number => 1.0);

  let halt: SchedulerDiagnostics | null = null;

  // Snapshot of in-flight pending promises. We use Promise.race on this to
  // wake up when ANY task settles.
  const inFlightPromises = new Map<string, Promise<void>>();

  const setHalt = (diag: Omit<SchedulerDiagnostics, 'effectiveConcurrency' | 'states'>): void => {
    if (halt) return; // first halt reason wins
    halt = {
      ...diag,
      effectiveConcurrency,
      states: Object.fromEntries(
        Array.from(records.values()).map(r => [r.taskId, r.state] as const),
      ),
    };
  };

  // --- Per-task dispatch step ----------------------------------------------
  const dispatchTask = async (taskId: string): Promise<void> => {
    const rec = records.get(taskId);
    if (!rec) return;
    rec.state = 'started';

    const preFlightEstimateUsd = estimate(taskId);

    // (1) Reserve budget. The reservation is atomic against concurrent
    // reservations via the writer's exclusive lock. A budget halt here
    // terminates the run.
    try {
      await opts.budget.reserve(taskId, {
        preFlightEstimateUsd,
        caps: opts.budgetCaps,
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        rec.state = 'failed';
        rec.errorMessage = err.message;
        setHalt({
          reason: 'budget_halt',
          detail: `task ${taskId} could not reserve budget: ${err.message}`,
        });
        return;
      }
      throw err;
    }

    // (2) Create worktree. Wrap in repo lock so a second claude-autopilot
    // invocation cannot interleave a `git worktree add` on the same repo.
    let created: CreatedTaskWorktree;
    try {
      created = await withRepoLock(
        {
          lockPath: opts.repoLockPath,
          command: 'scheduler create-worktree',
          run_id: opts.runId,
        },
        () => lifecycle.createTaskWorktree(taskId),
      );
    } catch (err) {
      // Release the budget reservation we just took (release with $0 actual
      // spend, then mark failed). The ledger will record the unused
      // reservation.
      await opts.budget.release(taskId, { actualCostUsd: 0 }).catch(() => undefined);
      rec.state = 'failed';
      rec.errorMessage = (err as Error).message;
      await emitTaskFailed(opts, taskId, {
        errorMessage: rec.errorMessage,
        errorType: 'crash',
        actualCostUsd: 0,
      });
      setHalt({
        reason: 'task_failed',
        detail: `task ${taskId} worktree creation failed: ${rec.errorMessage}`,
      });
      return;
    }
    rec.worktree = created;

    // (3) Emit task.started.
    await opts.writer.writeEvent({
      event: 'task.started',
      task_id: taskId,
      worktree_path: created.worktreePath,
      branch: created.branch,
      base_sha: created.baseSha,
      // PR 4 doesn't know what subagent_id PR 6 will assign. Stamp a
      // synthetic deterministic id so events.ndjson is self-consistent.
      subagent_id: `subagent-${opts.runId}-${taskId}`,
      dispatched_at: new Date().toISOString(),
      preflight_cost_estimate_usd: preFlightEstimateUsd,
    });

    // (4) Spawn subagent under AbortController + per-task timeout.
    const abort = new AbortController();
    rec.abort = abort;
    const timeoutHandle = setTimeout(() => {
      abort.abort(
        new GuardrailError(`task ${taskId} exceeded perSubagentTimeoutMs`, {
          code: 'transient_network',
          provider: 'concurrent-dispatch',
          details: { task_id: taskId, timeout_ms: opts.concurrency.perSubagentTimeoutMs },
        }),
      );
    }, opts.concurrency.perSubagentTimeoutMs);

    let runnerResult: SubagentRunResult;
    try {
      runnerResult = await opts.subagentRunner({
        taskId,
        worktreePath: created.worktreePath,
        branch: created.branch,
        baseSha: created.baseSha,
        signal: abort.signal,
        timeoutMs: opts.concurrency.perSubagentTimeoutMs,
      });
    } catch (err) {
      runnerResult = {
        exitStatus: 'failure',
        actualCostUsd: 0,
        errorMessage: (err as Error).message,
        aborted: abort.signal.aborted,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }

    rec.actualCostUsd = runnerResult.actualCostUsd;

    // (5) Timeout: emit task.timeout BEFORE task.failed, per spec dual-emit
    // contract. We detect timeout via abort.signal.aborted — the
    // AbortController firing because of the timer is the canonical timeout
    // signal. (A caller-initiated abort would also set this, but the
    // scheduler doesn't currently support external aborts in PR 4.)
    const timedOut = runnerResult.aborted === true || abort.signal.aborted;
    if (timedOut) {
      await opts.writer.writeEvent({
        event: 'task.timeout',
        task_id: taskId,
        timeout_ms: opts.concurrency.perSubagentTimeoutMs,
        // We can't distinguish SIGTERM vs SIGKILL here without subprocess
        // telemetry; mark SIGTERM (the first signal the runner sends).
        // PR 6's real runner will refine this if it observed an actual
        // SIGKILL escalation.
        killed_signal: 'SIGTERM',
      });
      // Release the reservation with the actual cost recorded so far.
      await opts.budget
        .release(taskId, { actualCostUsd: runnerResult.actualCostUsd })
        .catch(() => undefined);
      await emitTaskFailed(opts, taskId, {
        errorMessage:
          runnerResult.errorMessage ??
          `task ${taskId} timed out after ${opts.concurrency.perSubagentTimeoutMs}ms`,
        errorType: 'timeout',
        actualCostUsd: runnerResult.actualCostUsd,
      });
      rec.state = 'timeout';
      setHalt({
        reason: 'task_failed',
        detail: `task ${taskId} timed out`,
      });
      return;
    }

    // (6) Verify commits — ancestry + no-commits. Always under the gitQueue.
    const verification = await lifecycle.verifyTaskCommits(taskId, created.baseSha);
    rec.verification = verification;

    // (7) Map verification + runner outcome onto task.completed or task.failed.
    if (verification.kind === 'ancestry_violation') {
      await opts.budget
        .release(taskId, { actualCostUsd: runnerResult.actualCostUsd })
        .catch(() => undefined);
      await emitTaskFailed(opts, taskId, {
        errorMessage: verification.reason,
        errorType: 'ancestry_violation',
        actualCostUsd: runnerResult.actualCostUsd,
      });
      rec.state = 'ancestry_violation';
      setHalt({
        reason: 'task_failed',
        detail: `task ${taskId} produced an ancestry violation`,
      });
      return;
    }

    if (verification.kind === 'no_commits') {
      await opts.budget
        .release(taskId, { actualCostUsd: runnerResult.actualCostUsd })
        .catch(() => undefined);
      await emitTaskFailed(opts, taskId, {
        errorMessage:
          runnerResult.errorMessage ??
          `task ${taskId} produced no commits (base..tip is empty)`,
        errorType: 'no_commits',
        actualCostUsd: runnerResult.actualCostUsd,
      });
      rec.state = 'no_commits';
      setHalt({
        reason: 'task_failed',
        detail: `task ${taskId} produced no commits`,
      });
      return;
    }

    // verification.kind === 'ok' — but the runner itself might have
    // reported failure even though commits landed. Honour the runner's
    // exitStatus.
    if (runnerResult.exitStatus === 'failure') {
      await opts.budget
        .release(taskId, { actualCostUsd: runnerResult.actualCostUsd })
        .catch(() => undefined);
      await emitTaskFailed(opts, taskId, {
        errorMessage: runnerResult.errorMessage ?? `task ${taskId} subagent reported failure`,
        errorType: 'crash',
        actualCostUsd: runnerResult.actualCostUsd,
      });
      rec.state = 'failed';
      setHalt({
        reason: 'task_failed',
        detail: `task ${taskId} subagent reported failure`,
      });
      return;
    }

    // Happy path — emit task.completed with the IMMUTABLE tip_sha.
    await opts.budget
      .release(taskId, { actualCostUsd: runnerResult.actualCostUsd })
      .catch(() => undefined);
    await opts.writer.writeEvent({
      event: 'task.completed',
      task_id: taskId,
      base_sha: created.baseSha,
      task_branch_tip_sha: verification.tipSha,
      task_branch_name: created.branch,
      commit_shas: verification.commitShas,
      completed_at: new Date().toISOString(),
      actual_cost_usd: runnerResult.actualCostUsd,
      exit_status: 'success',
    });
    rec.state = 'completed';
  };

  // --- Outer scheduling loop ------------------------------------------------
  //
  // Tick = one pass that:
  //   (a) dispatches as many ready tasks as effectiveConcurrency permits
  //   (b) awaits the next in-flight completion (or returns if none in flight)
  //
  // Termination conditions:
  //   * every task in state 'merged' → success
  //   * halt was set during a dispatch (budget, failure, etc.)
  //   * no in-flight + no ready + at least one 'completed' task → stop and
  //     defer to merge orchestrator (PR 5 territory)
  //   * no in-flight + no ready + no 'completed' tasks remaining → deadlock
  while (!halt) {
    // Find ready tasks: pending tasks whose deps are ALL in state 'merged'.
    // (Empty dep set vacuously satisfies the predicate, so root tasks
    // dispatch on the first tick.)
    const ready: string[] = [];
    for (const rec of records.values()) {
      if (rec.state !== 'pending') continue;
      const deps = opts.graph.dependencies.get(rec.taskId);
      const depList = deps ? Array.from(deps) : [];
      const allMerged = depList.every(dep => records.get(dep)?.state === 'merged');
      if (allMerged) ready.push(rec.taskId);
    }

    // Sort ready by planIndex for deterministic dispatch order.
    const planIndexFor = (id: string): number =>
      opts.graph.tasks.find(t => t.id === id)?.planIndex ?? 0;
    ready.sort((a, b) => planIndexFor(a) - planIndexFor(b));

    // Dispatch up to (effectiveConcurrency - in-flight count) of them.
    const slots = effectiveConcurrency - inFlightPromises.size;
    const toDispatch = ready.slice(0, Math.max(0, slots));
    for (const taskId of toDispatch) {
      const promise = dispatchTask(taskId).catch(err => {
        const rec = records.get(taskId);
        if (rec) {
          rec.state = 'failed';
          rec.errorMessage = (err as Error).message;
        }
      });
      const tracked = promise.finally(() => {
        inFlightPromises.delete(taskId);
      });
      inFlightPromises.set(taskId, tracked);
    }

    // Termination + wait logic.
    if (inFlightPromises.size > 0) {
      // Wait for any in-flight to settle (so the next tick can re-evaluate
      // readiness + halt).
      await Promise.race(Array.from(inFlightPromises.values()));
      continue;
    }

    // Nothing in flight. Did we make progress?
    const remainingPending = Array.from(records.values()).filter(
      r => r.state === 'pending',
    );
    const completedNotMerged = Array.from(records.values()).filter(
      r => r.state === 'completed',
    );
    const allMerged = Array.from(records.values()).every(r => r.state === 'merged');

    if (allMerged) {
      setHalt({ reason: 'all_tasks_merged', detail: 'every task reached merged state' });
      break;
    }

    if (remainingPending.length === 0 && completedNotMerged.length > 0) {
      // PR 4 stops here. Merge orchestrator (PR 5) needs to take over.
      setHalt({
        reason: 'stopped_pending_merge_orchestrator',
        detail: `${completedNotMerged.length} task(s) completed but not merged; merge orchestrator (PR5) required to transition them to 'merged' before any downstream task can dispatch`,
      });
      break;
    }

    if (remainingPending.length > 0) {
      // No ready, nothing in flight, but tasks still pending. Some
      // dependency couldn't be satisfied. If at least one completed task
      // exists in the chain, it's "waiting on merge"; otherwise it's a
      // genuine deadlock.
      if (completedNotMerged.length > 0) {
        setHalt({
          reason: 'stopped_pending_merge_orchestrator',
          detail: `${remainingPending.length} task(s) waiting on ${completedNotMerged.length} completed-but-unmerged dep(s); merge orchestrator (PR5) required`,
        });
      } else {
        // Genuine deadlock — no progress possible. Dump state.
        setHalt({
          reason: 'deadlock_detected',
          detail: `${remainingPending.length} task(s) cannot dispatch and no work in flight — likely a non-merged terminal-failed dep`,
        });
      }
      break;
    }

    // Defensive: shouldn't reach here. Halt as deadlock to avoid hanging.
    setHalt({
      reason: 'deadlock_detected',
      detail: 'scheduler loop reached an unreachable state',
    });
    break;
  }

  // Drain any in-flight promises so cleanup is consistent.
  if (inFlightPromises.size > 0) {
    // Abort any still-running subagents (e.g. a halt fired during dispatch
    // and others are still running). Best-effort; the runner is responsible
    // for honoring AbortSignal.
    for (const rec of records.values()) {
      if (rec.state === 'started' && rec.abort) {
        rec.abort.abort(
          new GuardrailError('scheduler halted; cancelling in-flight subagents', {
            code: 'concurrency_lock',
            provider: 'concurrent-dispatch',
            details: { task_id: rec.taskId },
          }),
        );
      }
    }
    await Promise.allSettled(Array.from(inFlightPromises.values()));
  }

  // State-based cleanup for every terminal-state task. (Only `merged` tasks
  // get worktree + branch removed; everything else stays for inspection.)
  // PR 4 has no `merged` state — that's PR 5 — so this primarily exercises
  // the "preserve" branch. Tests still exercise the `merged` branch by
  // synthesizing the state.
  for (const rec of records.values()) {
    if (!rec.worktree) continue;
    const terminal = toTerminalState(rec.state);
    try {
      await lifecycle.cleanupTaskWorktree(rec.taskId, terminal);
    } catch (err) {
      // Cleanup failures are non-fatal — record on a warning event but
      // don't change the overall halt reason.
      await opts.writer
        .writeEvent({
          event: 'run.warning',
          message: `worktree cleanup failed for task ${rec.taskId}: ${(err as Error).message}`,
          details: { task_id: rec.taskId, terminal_state: terminal },
        })
        .catch(() => undefined);
    }
  }

  // Build the public DispatchResult.
  const merged: string[] = [];
  const completedUnmerged: string[] = [];
  const failed: string[] = [];
  const inFlight: string[] = [];
  const notStarted: string[] = [];
  for (const rec of records.values()) {
    switch (rec.state) {
      case 'merged':
        merged.push(rec.taskId);
        break;
      case 'completed':
        completedUnmerged.push(rec.taskId);
        break;
      case 'failed':
      case 'timeout':
      case 'ancestry_violation':
      case 'no_commits':
      case 'interrupted':
        failed.push(rec.taskId);
        break;
      case 'started':
        inFlight.push(rec.taskId);
        break;
      case 'pending':
        notStarted.push(rec.taskId);
        break;
    }
  }

  return {
    runId: opts.runId,
    merged,
    completedUnmerged,
    failed,
    inFlight,
    notStarted,
    diagnostics: halt ?? {
      reason: 'all_tasks_merged',
      detail: 'scheduler exited cleanly',
      effectiveConcurrency,
      states: Object.fromEntries(
        Array.from(records.values()).map(r => [r.taskId, r.state] as const),
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function emitTaskFailed(
  opts: SchedulerOptions,
  taskId: string,
  args: {
    errorMessage: string;
    errorType: 'timeout' | 'no_commits' | 'ancestry_violation' | 'budget_exceeded' | 'crash' | 'other';
    actualCostUsd: number;
  },
): Promise<void> {
  await opts.writer.writeEvent({
    event: 'task.failed',
    task_id: taskId,
    error_message: args.errorMessage,
    error_type: args.errorType,
    failed_at: new Date().toISOString(),
    actual_cost_usd: args.actualCostUsd,
  });
}

/** Compute effective concurrency exactly the way the scheduler does. Exposed
 *  so callers (and tests) can report it without re-running the scheduler.
 *
 *  effective = min(maxParallelSubagents, providerRateLimitConcurrency,
 *                  taskCount).
 *
 *  Floor at 1 so a misconfigured caller (e.g. taskCount=0) doesn't deadlock
 *  on a zero-slot scheduler. */
export function computeEffectiveConcurrency(args: {
  maxParallelSubagents: number;
  providerRateLimitConcurrency?: number;
  taskCount: number;
}): number {
  return Math.max(
    1,
    Math.min(
      args.maxParallelSubagents,
      args.providerRateLimitConcurrency ?? Number.MAX_SAFE_INTEGER,
      args.taskCount || 1,
    ),
  );
}

// Suppress unused — these types are exported so callers can construct
// terminal-state cleanup tests against the scheduler's contract.
export type { TaskTerminalState };
