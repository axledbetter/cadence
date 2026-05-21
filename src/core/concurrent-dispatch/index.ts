// src/core/concurrent-dispatch/index.ts
//
// Public API for the v7.11.0 concurrent subagent dispatch subsystem. This
// barrel re-exports the components the rest of the codebase consumes:
//
//   - Dep graph parser + types (PR 1, #197)
//   - Git operation queue (PR 2, #198)
//   - Budget reservation ledger + caps (PR 3, #199)
//   - Scheduler + worktree lifecycle (PR 4, this PR)
//   - Merge orchestrator (PR 5, #192 — not yet exported)
//
// Importers should reach for THIS module rather than the underlying files so
// the internal layout can be reorganized without breaking call sites.

export {
  parsePlan,
  buildDepGraph,
  DEFAULT_FALLBACK_POLICY,
} from './dep-graph.ts';
export {
  DepGraphCycleError,
  DepGraphResolutionError,
} from './types.ts';
export type {
  DepGraph,
  DepGraphWarning,
  DispatchResult,
  FallbackPolicy,
  ResolutionReason,
  TaskNode,
  Tier,
} from './types.ts';

export { GitOperationQueue } from './git-op-queue.ts';

export {
  BudgetReservation,
  BudgetExceededError,
} from './budget-reservation.ts';
export type {
  BudgetCaps,
  BudgetReplaySummary,
  IncreaseReservationOptions,
  ReleaseOptions,
  ReservationEntry,
  ReserveOptions,
} from './budget-reservation.ts';

export {
  WorktreeLifecycle,
  assertRunWorktreesDirAvailable,
} from './worktree-lifecycle.ts';
export type {
  CommitVerification,
  CreatedTaskWorktree,
  TaskTerminalState,
  WorktreeLifecycleOptions,
} from './worktree-lifecycle.ts';

export {
  runScheduler,
  computeEffectiveConcurrency,
} from './scheduler.ts';
export type {
  ConcurrencyConfig,
  SchedulerDiagnostics,
  SchedulerOptions,
  SchedulerResult,
  SubagentRunInput,
  SubagentRunner,
  SubagentRunResult,
} from './scheduler.ts';
