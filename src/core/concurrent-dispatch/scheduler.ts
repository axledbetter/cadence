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
  assertRunWorktreesDirAvailable,
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
   *  subagent. */
  aborted?: boolean;
  /** Why the runner saw an abort, if any. Defaults to 'timeout' when
   *  unspecified (back-compat with the v7.11.0-pre.4 scheduler shape).
   *  PR 6's real runner should set this explicitly so the scheduler
   *  doesn't misclassify user-cancellations or provider-side aborts
   *  as timeouts (Codex pass 2 WARNING). */
  abortReason?: 'timeout' | 'cancelled' | 'shutdown' | 'provider_abort';
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
  /** Optional merge orchestrator callback (Codex pass 1 WARNING: explicit
   *  contract for PR5 integration). When provided, the scheduler invokes
   *  this after every `task.completed` and uses the resulting decision to
   *  transition the task to `merged` (unblocking downstream dispatchers).
   *
   *  PR 4 leaves this undefined; the scheduler halts gracefully with
   *  `stopped_pending_merge_orchestrator` when tasks complete without a
   *  mergeOrchestrator. PR 5 (#192) supplies the real implementation that
   *  performs cherry-picks, emits `task.merged` / `task.merge_conflict`,
   *  and returns the corresponding `MergeDecision`.
   *
   *  The callback receives the completed task's tip_sha + base_sha + branch
   *  + commit_shas so it has everything it needs to cherry-pick without
   *  re-reading events.ndjson. It is responsible for emitting the
   *  `task.merged` or `task.merge_conflict` event itself — the scheduler
   *  only uses the returned decision to update its in-memory state machine. */
  mergeOrchestrator?: MergeOrchestrator;
}

/** Decision returned by the merge orchestrator. PR 4 declares this shape so
 *  PR 5 can implement against a stable interface. */
export type MergeDecision =
  | { kind: 'merged' }
  | { kind: 'merge_conflict'; reason: string }
  | { kind: 'merge_aborted'; reason: string };

export interface MergeOrchestratorInput {
  taskId: string;
  baseSha: string;
  taskBranchTipSha: string;
  taskBranchName: string;
  commitShas: string[];
}

export type MergeOrchestrator = (
  input: MergeOrchestratorInput,
) => Promise<MergeDecision>;

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
  | 'interrupted'
  | 'merge_conflict';

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
    case 'merge_conflict':
      return 'merge_conflict';
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
/** Validate ConcurrencyConfig at scheduler-entry. Codex pass 2 WARNING:
 *  silent clamping of perSubagentTimeoutMs hides deployment misconfiguration.
 *  Reject non-finite, zero, negative, or out-of-range timeouts up front so
 *  the operator sees a clear error instead of a surprise behaviour change.
 *
 *  `maxParallelSubagents` is still defensively clamped inside
 *  `computeEffectiveConcurrency` (caller is expected to validate `1..8` at
 *  config-load); but `perSubagentTimeoutMs` has no upstream validator yet,
 *  so we enforce it here. */
function validateConcurrencyConfig(cfg: ConcurrencyConfig): void {
  // Codex pass 3 WARNING: enforce integer + range, not just finite.
  if (
    !Number.isInteger(cfg.perSubagentTimeoutMs) ||
    cfg.perSubagentTimeoutMs <= 0 ||
    cfg.perSubagentTimeoutMs > 2 ** 31 - 1
  ) {
    throw new GuardrailError(
      `concurrency.perSubagentTimeoutMs must be a positive integer in [1, 2^31-1] (got ${String(cfg.perSubagentTimeoutMs)})`,
      {
        code: 'invalid_config',
        provider: 'concurrent-dispatch',
        details: { perSubagentTimeoutMs: cfg.perSubagentTimeoutMs },
      },
    );
  }
  if (cfg.sigkillGraceMs !== undefined) {
    if (
      !Number.isInteger(cfg.sigkillGraceMs) ||
      cfg.sigkillGraceMs <= 0 ||
      cfg.sigkillGraceMs > 2 ** 31 - 1
    ) {
      throw new GuardrailError(
        `concurrency.sigkillGraceMs must be a positive integer in [1, 2^31-1] (got ${String(cfg.sigkillGraceMs)})`,
        {
          code: 'invalid_config',
          provider: 'concurrent-dispatch',
          details: { sigkillGraceMs: cfg.sigkillGraceMs },
        },
      );
    }
  }
}

export async function runScheduler(opts: SchedulerOptions): Promise<SchedulerResult> {
  validateConcurrencyConfig(opts.concurrency);

  // Bugbot HIGH: refuse to start if `.claude/worktrees/<run-ulid>/` is
  // already populated from a crashed prior run. The spec contract is
  // explicit — operator must clear via `runs gc` before the scheduler
  // touches the repo.
  assertRunWorktreesDirAvailable(opts.runWorktreesDir);

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

  const effectiveConcurrency = computeEffectiveConcurrency({
    maxParallelSubagents: opts.concurrency.maxParallelSubagents,
    providerRateLimitConcurrency: opts.concurrency.providerRateLimitConcurrency,
    taskCount: allTaskIds.length,
  });

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
    // Bugbot HIGH (failures don't abort in-flight peers): when a halt
    // fires, signal abort to every other in-flight subagent immediately
    // so they don't continue mutating worktrees / spending budget on
    // work that will never merge.
    for (const rec of records.values()) {
      if (rec.state === 'started' && rec.abort && !rec.abort.signal.aborted) {
        rec.abort.abort(
          new GuardrailError(
            `scheduler halted (${diag.reason}); cancelling in-flight subagent`,
            {
              code: 'concurrency_lock',
              provider: 'concurrent-dispatch',
              details: { task_id: rec.taskId, halt_reason: diag.reason },
            },
          ),
        );
      }
    }
  };

  // --- Per-task dispatch step ----------------------------------------------
  //
  // Structured to guarantee budget reservation is ALWAYS released on every
  // terminal path (Codex pass 1 WARNING — single try/finally around the
  // post-reserve work). Scheduler also enforces a HARD wall-clock timeout
  // via Promise.race: the runner is given the AbortSignal as a cooperative
  // cancellation channel, but the scheduler does NOT depend on the runner
  // honouring it for terminal state transitions (Codex pass 1 CRITICAL #2).
  //
  // Terminal state guard: once a task has transitioned out of 'started',
  // late runner results are ignored without emitting additional terminal
  // events (Codex pass 1 WARNING — idempotent terminal emission).
  const dispatchTask = async (taskId: string): Promise<void> => {
    const rec = records.get(taskId);
    if (!rec) return;
    rec.state = 'started';

    const preFlightEstimateUsd = estimate(taskId);

    // (1) Reserve budget.
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

    // Track whether we already released the budget + the LAST intended
    // release amount. Codex pass 3 WARNING: a finally-block retry with $0
    // after a failed actualCost release would understate spend; instead
    // retry with the same amount the caller intended.
    let budgetReleased = false;
    let pendingReleaseActualCostUsd: number | null = null;
    const releaseBudget = async (actualCostUsd: number): Promise<void> => {
      if (budgetReleased) return;
      pendingReleaseActualCostUsd = actualCostUsd;
      try {
        await opts.budget.release(taskId, { actualCostUsd });
        budgetReleased = true;
      } catch (err) {
        const msg = (err as Error).message;
        // "already released" is benign on a retry — don't surface; just
        // mark the flag so we don't loop.
        if (/already released/i.test(msg)) {
          budgetReleased = true;
          return;
        }
        // Real failure — emit a warning so the operator can see the
        // ledger drift. Do NOT set the flag; the finally block will
        // retry with the same `pendingReleaseActualCostUsd` value
        // captured above (NOT $0 — that would corrupt spend tracking).
        await opts.writer
          .writeEvent({
            event: 'run.warning',
            message: `budget release failed for task ${taskId}: ${msg}`,
            details: { task_id: taskId, actual_cost_usd: actualCostUsd },
          })
          .catch(() => undefined);
      }
    };

    // Track whether a terminal event (task.completed / task.failed /
    // task.timeout) has been emitted. Once set, late runner results are
    // silently swallowed (Codex pass 1 WARNING — idempotent terminal
    // emission). NOTE: this is INDEPENDENT of the merge transition —
    // moving from `completed` to `merged` via the mergeOrchestrator
    // callback is a SEPARATE lifecycle stage that does not go through
    // transitionTo (Codex pass 2 WARNING clarification).
    let terminalEmitted = false;
    const transitionTo = (state: TaskState): boolean => {
      if (terminalEmitted) return false;
      terminalEmitted = true;
      rec.state = state;
      return true;
    };

    try {
      // (2) Create worktree.
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
        const msg = (err as Error).message;
        if (transitionTo('failed')) {
          rec.errorMessage = msg;
          await emitTaskFailed(opts, taskId, {
            errorMessage: msg,
            errorType: 'crash',
            actualCostUsd: 0,
          });
        }
        setHalt({
          reason: 'task_failed',
          detail: `task ${taskId} worktree creation failed: ${msg}`,
        });
        return;
      }
      rec.worktree = created;

      // (3) Emit task.started. Codex pass 2 WARNING: a write failure here
      // would leave a worktree allocated with no durable record. Treat as
      // an explicit task startup failure: emit task.failed, release
      // budget, halt run, and let the state-based cleanup preserve the
      // worktree for inspection.
      try {
        await opts.writer.writeEvent({
          event: 'task.started',
          task_id: taskId,
          worktree_path: created.worktreePath,
          branch: created.branch,
          base_sha: created.baseSha,
          subagent_id: `subagent-${opts.runId}-${taskId}`,
          dispatched_at: new Date().toISOString(),
          preflight_cost_estimate_usd: preFlightEstimateUsd,
        });
      } catch (err) {
        const msg = (err as Error).message;
        if (transitionTo('failed')) {
          rec.errorMessage = `task.started write failed: ${msg}`;
          await releaseBudget(0);
          await emitTaskFailed(opts, taskId, {
            errorMessage: rec.errorMessage,
            errorType: 'crash',
            actualCostUsd: 0,
          }).catch(() => undefined);
        }
        setHalt({
          reason: 'task_failed',
          detail: `task ${taskId} task.started write failed: ${msg}`,
        });
        return;
      }

      // (4) Spawn subagent under AbortController. Hard scheduler-level
      // timeout via Promise.race — we do NOT block on the runner honouring
      // the AbortSignal. If the runner is hung, the timeout promise
      // resolves first and the scheduler emits terminal events even while
      // the runner's promise is still in-flight. The runner's eventual
      // settlement is swallowed by the terminal-state guard.
      const abort = new AbortController();
      rec.abort = abort;

      type TimeoutSentinel = { __timeout: true };
      const timeoutSentinel: TimeoutSentinel = { __timeout: true };
      // `validateConcurrencyConfig` already asserted this is a finite
      // positive integer within setTimeout's safe range; no clamping
      // needed (Codex pass 2 WARNING — silent clamp was the original
      // smell).
      const safeTimeoutMs = opts.concurrency.perSubagentTimeoutMs;

      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<TimeoutSentinel>(resolve => {
        timeoutHandle = setTimeout(() => {
          // Fire AbortController so the runner has a chance to clean up
          // cooperatively. We do NOT wait for it — the scheduler proceeds
          // to terminal-event emission immediately.
          abort.abort(
            new GuardrailError(`task ${taskId} exceeded perSubagentTimeoutMs`, {
              code: 'transient_network',
              provider: 'concurrent-dispatch',
              details: { task_id: taskId, timeout_ms: safeTimeoutMs },
            }),
          );
          resolve(timeoutSentinel);
        }, safeTimeoutMs);
      });

      const runnerPromise: Promise<SubagentRunResult> = opts.subagentRunner({
        taskId,
        worktreePath: created.worktreePath,
        branch: created.branch,
        baseSha: created.baseSha,
        signal: abort.signal,
        timeoutMs: safeTimeoutMs,
      }).catch((err): SubagentRunResult => ({
        exitStatus: 'failure',
        actualCostUsd: 0,
        errorMessage: (err as Error).message,
        aborted: abort.signal.aborted,
      }));

      const raceResult = await Promise.race<SubagentRunResult | TimeoutSentinel>([
        runnerPromise,
        timeoutPromise,
      ]);

      if (timeoutHandle !== null) clearTimeout(timeoutHandle);

      // Detect timeout via sentinel — robust against late runner returns.
      if ((raceResult as TimeoutSentinel).__timeout === true) {
        // Codex pass 2 CRITICAL #1: we fired AbortSignal, but the
        // subagent may still be mutating the worktree. Wait a BOUNDED
        // grace period (default 30s per spec; configurable via
        // `concurrency.sigkillGraceMs` for tests) for the runner to
        // confirm termination.
        //
        // Codex pass 3 CRITICAL #1 (settled wrapper): the grace race
        // wraps `runnerPromise` so rejections become a settled
        // `{ ok: false }` shape — a rejecting runner CANNOT throw past
        // the await and skip terminal-event emission.
        //
        // Codex pass 3 CRITICAL #2 (kill confirmation): the runner is
        // contractually required to set `aborted: true` when it
        // confirms termination. If the grace timer fires, we record
        // `kill_unconfirmed` semantics by emitting SIGKILL (PR6's real
        // runner escalates) — but the worktree is state-based-
        // preserved, so any leaked writes are inspectable rather than
        // destroyed downstream. The downstream merge orchestrator
        // (PR5) is responsible for refusing to merge a task whose
        // worktree may still be undergoing writes; we propagate that
        // via the killed_signal field.
        //
        // Codex pass 3 WARNING (timer cleanup): the grace setTimeout
        // is now tracked and cleared in the finally so it doesn't keep
        // the event loop alive after the runner settles first.
        const sigkillGraceMs = opts.concurrency.sigkillGraceMs ?? 30_000;
        let killedSignal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM';
        let partialActualCostUsd = 0;
        const graceSentinel = Symbol('grace-timeout');
        type SettledRunnerResult =
          | { ok: true; result: SubagentRunResult }
          | { ok: false; err: Error };
        const settledRunner: Promise<SettledRunnerResult> = runnerPromise.then(
          (result): SettledRunnerResult => ({ ok: true, result }),
          (err): SettledRunnerResult => ({ ok: false, err: err as Error }),
        );
        let graceTimerHandle: ReturnType<typeof setTimeout> | null = null;
        const gracePromise = new Promise<typeof graceSentinel>(resolve => {
          graceTimerHandle = setTimeout(() => resolve(graceSentinel), sigkillGraceMs);
        });
        let graceResult: SettledRunnerResult | typeof graceSentinel;
        try {
          graceResult = await Promise.race<SettledRunnerResult | typeof graceSentinel>([
            settledRunner,
            gracePromise,
          ]);
        } finally {
          if (graceTimerHandle !== null) clearTimeout(graceTimerHandle);
        }
        if (graceResult === graceSentinel) {
          killedSignal = 'SIGKILL';
          // Detach the still-running promise. State-based cleanup
          // preserves the worktree so any leaked writes are inspectable.
          settledRunner.catch(() => undefined);
        } else if (graceResult.ok) {
          // Runner settled within grace with a result — capture its
          // reported cost for accurate budget release.
          partialActualCostUsd = graceResult.result.actualCostUsd;
        } else {
          // Runner settled within grace by REJECTING. We don't know
          // partial cost; release with $0 and let the operator see
          // the rejection message via the run.warning emitted on
          // releaseBudget failure (or absent it, the task.failed
          // error_message captures the runner's error).
          partialActualCostUsd = 0;
        }
        if (transitionTo('timeout')) {
          await opts.writer.writeEvent({
            event: 'task.timeout',
            task_id: taskId,
            timeout_ms: safeTimeoutMs,
            killed_signal: killedSignal,
          });
          await releaseBudget(partialActualCostUsd);
          await emitTaskFailed(opts, taskId, {
            errorMessage: `task ${taskId} timed out after ${safeTimeoutMs}ms (scheduler hard timeout; ${killedSignal})`,
            errorType: 'timeout',
            actualCostUsd: partialActualCostUsd,
          });
        }
        setHalt({
          reason: 'task_failed',
          detail: `task ${taskId} timed out (${killedSignal})`,
        });
        return;
      }

      const runnerResult = raceResult as SubagentRunResult;
      rec.actualCostUsd = runnerResult.actualCostUsd;

      // (5) Runner reported abort — translate to the right terminal
      // event based on abortReason (Codex pass 2 WARNING). Only an
      // explicit `timeout` abort emits the task.timeout + task.failed
      // dual-pair; other reasons (cancelled, shutdown, provider_abort)
      // emit task.failed with error_type: 'crash' or 'other'.
      if (runnerResult.aborted === true) {
        const reason = runnerResult.abortReason ?? 'timeout';
        if (reason === 'timeout') {
          if (transitionTo('timeout')) {
            await opts.writer.writeEvent({
              event: 'task.timeout',
              task_id: taskId,
              timeout_ms: safeTimeoutMs,
              killed_signal: 'SIGTERM',
            });
            await releaseBudget(runnerResult.actualCostUsd);
            await emitTaskFailed(opts, taskId, {
              errorMessage:
                runnerResult.errorMessage ??
                `task ${taskId} aborted (runner-reported timeout)`,
              errorType: 'timeout',
              actualCostUsd: runnerResult.actualCostUsd,
            });
          }
          setHalt({
            reason: 'task_failed',
            detail: `task ${taskId} aborted (runner-reported timeout)`,
          });
        } else {
          // cancelled / shutdown / provider_abort — terminal failure
          // but NOT a timeout. error_type is 'other' so resume
          // classification doesn't conflate them.
          if (transitionTo('failed')) {
            await releaseBudget(runnerResult.actualCostUsd);
            await emitTaskFailed(opts, taskId, {
              errorMessage:
                runnerResult.errorMessage ??
                `task ${taskId} aborted (reason=${reason})`,
              errorType: 'other',
              actualCostUsd: runnerResult.actualCostUsd,
            });
          }
          setHalt({
            reason: 'task_failed',
            detail: `task ${taskId} aborted (reason=${reason})`,
          });
        }
        return;
      }

      // (6) Verify commits — ancestry + no-commits. Always under the
      // gitQueue.
      const verification = await lifecycle.verifyTaskCommits(taskId, created.baseSha);
      rec.verification = verification;

      // (7) Map verification + runner outcome onto task.completed or
      // task.failed.
      if (verification.kind === 'ancestry_violation') {
        if (transitionTo('ancestry_violation')) {
          await releaseBudget(runnerResult.actualCostUsd);
          await emitTaskFailed(opts, taskId, {
            errorMessage: verification.reason,
            errorType: 'ancestry_violation',
            actualCostUsd: runnerResult.actualCostUsd,
          });
        }
        setHalt({
          reason: 'task_failed',
          detail: `task ${taskId} produced an ancestry violation`,
        });
        return;
      }

      if (verification.kind === 'no_commits') {
        if (transitionTo('no_commits')) {
          await releaseBudget(runnerResult.actualCostUsd);
          await emitTaskFailed(opts, taskId, {
            errorMessage:
              runnerResult.errorMessage ??
              `task ${taskId} produced no commits (base..tip is empty)`,
            errorType: 'no_commits',
            actualCostUsd: runnerResult.actualCostUsd,
          });
        }
        setHalt({
          reason: 'task_failed',
          detail: `task ${taskId} produced no commits`,
        });
        return;
      }

      // verification.kind === 'ok' — but runner might have reported
      // failure even though commits landed. Honour exitStatus.
      if (runnerResult.exitStatus === 'failure') {
        if (transitionTo('failed')) {
          await releaseBudget(runnerResult.actualCostUsd);
          await emitTaskFailed(opts, taskId, {
            errorMessage:
              runnerResult.errorMessage ??
              `task ${taskId} subagent reported failure`,
            errorType: 'crash',
            actualCostUsd: runnerResult.actualCostUsd,
          });
        }
        setHalt({
          reason: 'task_failed',
          detail: `task ${taskId} subagent reported failure`,
        });
        return;
      }

      // Happy path — emit task.completed with the IMMUTABLE tip_sha.
      if (transitionTo('completed')) {
        await releaseBudget(runnerResult.actualCostUsd);
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

        // (8) Invoke merge orchestrator if provided (PR 5 integration
        // point). Without one, the task stays in 'completed' and the
        // scheduler eventually halts with stopped_pending_merge_orchestrator.
        if (opts.mergeOrchestrator) {
          try {
            const decision = await opts.mergeOrchestrator({
              taskId,
              baseSha: created.baseSha,
              taskBranchTipSha: verification.tipSha,
              taskBranchName: created.branch,
              commitShas: verification.commitShas,
            });
            if (decision.kind === 'merged') {
              // Transition out of the terminal 'completed' state. The
              // mergeOrchestrator is the only legitimate path to 'merged'
              // — directly overwriting the state here is intentional.
              rec.state = 'merged';
            } else if (decision.kind === 'merge_conflict') {
              // Bugbot MEDIUM: keep merge_conflict distinct from generic
              // 'failed' so state-based cleanup writes the right marker
              // file and `runs cleanup` shows the right diagnostic.
              rec.state = 'merge_conflict';
              rec.errorMessage = `merge conflict: ${decision.reason}`;
              setHalt({
                reason: 'task_failed',
                detail: `task ${taskId} merge conflict: ${decision.reason}`,
              });
            } else {
              rec.state = 'failed';
              rec.errorMessage = `merge aborted: ${decision.reason}`;
              setHalt({
                reason: 'task_failed',
                detail: `task ${taskId} merge aborted: ${decision.reason}`,
              });
            }
          } catch (err) {
            // Orchestrator threw — treat as merge_aborted with the throw
            // message. Halt the run.
            const msg = (err as Error).message;
            rec.state = 'failed';
            rec.errorMessage = `merge orchestrator threw: ${msg}`;
            setHalt({
              reason: 'task_failed',
              detail: `task ${taskId} merge orchestrator failed: ${msg}`,
            });
          }
        }
      }
    } finally {
      // Defensive belt-and-braces: if a code path above failed to release
      // (e.g. an unexpected throw between reserve and the terminal emit),
      // release here. Use the LAST intended amount (Codex pass 3 WARNING)
      // — falling back to $0 only when no terminal path ever specified a
      // cost (i.e. the throw happened before any explicit release attempt).
      if (!budgetReleased) {
        const retryCost =
          pendingReleaseActualCostUsd !== null ? pendingReleaseActualCostUsd : 0;
        // Re-arm pendingReleaseActualCostUsd so the retry itself is
        // visible to releaseBudget's own diagnostics path.
        pendingReleaseActualCostUsd = null;
        await releaseBudget(retryCost);
      }
    }
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
      // Bugbot HIGH (dispatchTask catch leaks budget): the inner try/
      // finally in dispatchTask handles budget release for known
      // failure paths; this outer catch is the safety net for
      // truly-unexpected throws. We emit task.failed here so
      // events.ndjson always carries a terminal record even when a
      // bug in scheduler internals throws unexpectedly.
      const promise = dispatchTask(taskId).catch(async err => {
        const rec = records.get(taskId);
        if (rec && rec.state === 'started') {
          rec.state = 'failed';
          rec.errorMessage = (err as Error).message;
          // Best-effort emit task.failed so the events log is complete.
          // dispatchTask's try/finally has already released the budget
          // (with the last-intended cost) by the time we reach this
          // catch — BudgetReservation.release is idempotent (rejects
          // on already-released with adapter_bug). So emit task.failed
          // and let the budget ledger surface any drift via its own
          // diagnostics.
          await opts.writer
            .writeEvent({
              event: 'task.failed',
              task_id: taskId,
              error_message: (err as Error).message,
              error_type: 'crash',
              failed_at: new Date().toISOString(),
              actual_cost_usd: rec.actualCostUsd ?? 0,
            })
            .catch(() => undefined);
        }
        setHalt({
          reason: 'task_failed',
          detail: `task ${taskId} dispatch threw unexpectedly: ${(err as Error).message}`,
        });
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

  // Drain any in-flight promises so cleanup is consistent. Bounded by
  // sigkillGraceMs (bugbot HIGH: drain waits forever on runner) — a
  // hung runner that ignores AbortSignal must not block scheduler exit.
  // After the bound, we detach remaining in-flight promises; their
  // worktrees are state-based-preserved for forensic inspection.
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
    const drainTimeoutMs = opts.concurrency.sigkillGraceMs ?? 30_000;
    const drainSentinel = Symbol('drain-timeout');
    let drainTimerHandle: ReturnType<typeof setTimeout> | null = null;
    const drainTimerPromise = new Promise<typeof drainSentinel>(resolve => {
      drainTimerHandle = setTimeout(() => resolve(drainSentinel), drainTimeoutMs);
    });
    try {
      await Promise.race([
        Promise.allSettled(Array.from(inFlightPromises.values())),
        drainTimerPromise,
      ]);
    } finally {
      if (drainTimerHandle !== null) clearTimeout(drainTimerHandle);
    }
    // Detach any still-pending promises so they don't keep the event
    // loop alive after scheduler returns. State-based cleanup runs next
    // and preserves their worktrees.
    for (const p of inFlightPromises.values()) {
      p.catch(() => undefined);
    }
  }

  // State-based cleanup for every terminal-state task. Wrapped in
  // withRepoLock (Codex pass 1 WARNING) — `git worktree remove` and
  // `git branch -D` are repo-level mutations that can race with another
  // claude-autopilot invocation (e.g. `runs cleanup` running concurrently).
  // Only `merged` removes worktree+branch; others write a marker file in
  // place which is non-mutating from git's perspective but still benefits
  // from serialization vs concurrent inspectors.
  for (const rec of records.values()) {
    if (!rec.worktree) continue;
    const terminal = toTerminalState(rec.state);
    try {
      await withRepoLock(
        {
          lockPath: opts.repoLockPath,
          command: 'scheduler cleanup-worktree',
          run_id: opts.runId,
        },
        () => lifecycle.cleanupTaskWorktree(rec.taskId, terminal),
      );
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
      case 'merge_conflict':
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
 *  Defensive clamping (Codex pass 1 WARNING): even though the caller is
 *  expected to validate `maxParallelSubagents` is `1..8` at config-load,
 *  this function tolerates garbage inputs (`NaN`, `Infinity`, negative,
 *  non-integer) and clamps them to safe values. This prevents the scheduler
 *  from busy-looping on `effective=0` or over-dispatching on `effective=Infinity`.
 *
 *  Returns `1` minimum so a misconfigured caller never deadlocks the
 *  scheduler. */
export function computeEffectiveConcurrency(args: {
  maxParallelSubagents: number;
  providerRateLimitConcurrency?: number;
  taskCount: number;
}): number {
  const clampPositiveInt = (n: number, fallback: number): number => {
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(1, Math.floor(n));
  };
  const maxParallel = clampPositiveInt(args.maxParallelSubagents, 1);
  const providerLimit =
    args.providerRateLimitConcurrency === undefined
      ? Number.MAX_SAFE_INTEGER
      : clampPositiveInt(args.providerRateLimitConcurrency, Number.MAX_SAFE_INTEGER);
  const taskCount = Number.isFinite(args.taskCount) && args.taskCount > 0
    ? Math.floor(args.taskCount)
    : 1;
  return Math.max(1, Math.min(maxParallel, providerLimit, taskCount));
}

// Suppress unused — these types are exported so callers can construct
// terminal-state cleanup tests against the scheduler's contract.
export type { TaskTerminalState };
