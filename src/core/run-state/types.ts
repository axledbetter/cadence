// src/core/run-state/types.ts
//
// v6 Run State Engine — pure data layer types. Phase 1 (persistence) only.
// Behavior — phase wrapping, CLI verbs, budget enforcement, etc. — lands in
// later phases. The shapes here are versioned via `schema_version: 1` so a
// future migration can detect and migrate older runs.
//
// Spec: docs/specs/v6-run-state-engine.md ("State on disk", "Run lifecycle",
// "Idempotency rules + external operation ledger", "Persistence protocol").

/** Schema version for everything written by this engine. Bump on breaking
 *  changes to RunState / RunEvent / PhaseSnapshot shape.
 *
 *  v7.0 — bumped from 1 to 2 to signal the v7 cycle on every newly-written
 *  state.json. v6.x runs (schema_version=1) remain readable by v7 binaries
 *  because `RUN_STATE_MIN_SUPPORTED_SCHEMA_VERSION` stays at 1. v6 binaries
 *  cannot read v7-written runs; the corrupted_state error includes a
 *  "downgrade resume is not supported" hint so operators know why. */
export const RUN_STATE_SCHEMA_VERSION = 2 as const;
export type SchemaVersion = typeof RUN_STATE_SCHEMA_VERSION;

/** Identifies a single OS-level writer. PID + a hash of the hostname (we
 *  don't persist the raw hostname to the lock metadata so co-tenant signal
 *  doesn't leak between users sharing a directory). */
export interface WriterId {
  pid: number;
  hostHash: string;
}

/** Top-level run status, mirroring the lifecycle diagram in the spec. */
export type RunStatus =
  | 'pending'    // created, not yet started any phase
  | 'running'    // a phase is currently executing
  | 'paused'     // a phase failed; resumable via `run resume <id>`
  | 'success'    // all phases succeeded
  | 'failed'     // terminal failure that cannot be retried (budget exceeded, etc.)
  | 'aborted';   // user / signal interrupted

/** Per-phase status within a run. */
export type PhaseStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'aborted';

/** External operation reference — the persisted breadcrumb that makes replay
 *  decisions deterministic. Used heavily in Phase 6 (idempotency contracts);
 *  typed now so events can carry it without later schema churn.
 *
 *  v6.2.1 — `migration-batch` joins the union as the side-effect contract's
 *  PRE-effect breadcrumb for the `migrate` phase. Semantics: a deterministic
 *  id covers a planned migration batch and is emitted BEFORE the dispatcher
 *  is invoked, so a partial crash leaves a resume target visible to the
 *  orchestrator's preflight readback. The post-effect `migration-version`
 *  refs (one per actually-applied migration) remain authoritative for
 *  reconciliation; `migration-batch` exists purely so resume can tell
 *  "we started this batch but didn't finish" apart from "we never started." */
export type ExternalRefKind =
  | 'github-pr'
  | 'github-comment'
  | 'git-remote-push'
  | 'deploy'
  | 'migration-batch'
  | 'migration-version'
  | 'rollback-target'
  | 'spec-file'
  | 'plan-file'
  | 'sarif-artifact'
  | 'review-comments';

export interface ExternalRef {
  kind: ExternalRefKind;
  /** Provider-specific identifier (PR number, commit SHA, deploy ID, …). */
  id: string;
  provider?: string;
  /** Human-readable artifact link if the provider exposes one. */
  url?: string;
  /** ISO timestamp of the platform's confirmation. */
  observedAt: string;
}

/** Per-phase artifact pointer recorded inside the snapshot. */
export interface PhaseArtifactRef {
  /** Logical name (e.g. "spec", "plan", "impl-diff"). */
  name: string;
  /** Path inside `artifacts/` (relative to run dir). */
  path: string;
  sha256?: string;
  size?: number;
  copiedAt?: string;
}

/** Snapshot of a single phase, persisted under `phases/<name>.json` and
 *  reflected inside state.json's `phases[]`. */
export interface PhaseSnapshot {
  schema_version: SchemaVersion;
  name: string;
  /** Order within the run (0-indexed). */
  index: number;
  status: PhaseStatus;
  /** True iff `RunPhase.idempotent` was declared true at registration. */
  idempotent: boolean;
  /** True iff `RunPhase.hasSideEffects` was declared true at registration. */
  hasSideEffects: boolean;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** Sum of `phase.cost` events for this phase. */
  costUSD: number;
  attempts: number;
  /** Last failure message (string) if status === 'failed'. */
  lastError?: string;
  artifacts: PhaseArtifactRef[];
  externalRefs: ExternalRef[];
  /** Phase-specific metadata. Free-form; engine doesn't introspect. */
  meta?: Record<string, unknown>;
  /** Phase 6 — last successful output, persisted so a future
   *  `skip-already-applied` decision can return it without re-execution.
   *  The engine writes this on every `phase.success`; absent on failed
   *  / pre-Phase-6 snapshots. JSON-serializable values only. */
  result?: unknown;
}

/** The state.json checkpoint. Authoritative answer is always
 *  events.ndjson; this is a derived snapshot for O(1) status queries. */
export interface RunState {
  schema_version: SchemaVersion;
  runId: string;
  /** ULID generation time, ISO. */
  startedAt: string;
  endedAt?: string;
  status: RunStatus;
  /** Phase order is fixed at run creation. */
  phases: PhaseSnapshot[];
  /** Index into `phases[]` of the currently-running or last-attempted phase. */
  currentPhaseIdx: number;
  /** Sum of phase.cost events across the whole run. */
  totalCostUSD: number;
  /** Last seq written to events.ndjson at the time of the snapshot. */
  lastEventSeq: number;
  /** The writer that wrote this snapshot. */
  writerId: WriterId;
  /** Working directory the run was started in (absolute path). */
  cwd: string;
  /** Snapshot of the run config at creation (subset of guardrail.config.yaml).
   *  Free-form; engine doesn't introspect here, later phases do. */
  config?: Record<string, unknown>;
}

// ----------------------------------------------------------------------------
// Event union. Every state transition writes exactly one event to
// events.ndjson, fsync'd before the snapshot is updated. Each variant carries
// its own discriminant under the `event` field plus the universal envelope
// (ts, runId, seq, schema_version, writerId).
// ----------------------------------------------------------------------------

/** Universal envelope on every event line. */
export interface RunEventBase {
  schema_version: SchemaVersion;
  /** ISO timestamp. */
  ts: string;
  runId: string;
  /** Monotonic per-run sequence. Receivers MUST detect gaps. */
  seq: number;
  /** The writer that appended this event. */
  writerId: WriterId;
}

export interface RunStartEvent extends RunEventBase {
  event: 'run.start';
  phases: string[];
  config?: Record<string, unknown>;
}

export interface RunCompleteEvent extends RunEventBase {
  event: 'run.complete';
  status: 'success' | 'failed' | 'aborted';
  totalCostUSD: number;
  durationMs: number;
}

export interface RunWarningEvent extends RunEventBase {
  event: 'run.warning';
  message: string;
  details?: Record<string, unknown>;
}

export interface RunRecoveryEvent extends RunEventBase {
  event: 'run.recovery';
  reason:
    | 'recovered-from-partial-write'
    | 'recovered-from-corrupt-snapshot'
    | 'recovered-from-missing-snapshot';
  details?: Record<string, unknown>;
}

export interface PhaseStartEvent extends RunEventBase {
  event: 'phase.start';
  phase: string;
  phaseIdx: number;
  idempotent: boolean;
  hasSideEffects: boolean;
  /** Attempt counter, 1-based. >1 implies a resume / retry. */
  attempt: number;
}

export interface PhaseSuccessEvent extends RunEventBase {
  event: 'phase.success';
  phase: string;
  phaseIdx: number;
  durationMs: number;
  artifacts: PhaseArtifactRef[];
}

export interface PhaseFailedEvent extends RunEventBase {
  event: 'phase.failed';
  phase: string;
  phaseIdx: number;
  durationMs: number;
  /** Stringified error message. Stack traces stay out of the durable log. */
  error: string;
  /** Optional structured error code (matches GuardrailError.code if thrown). */
  errorCode?: string;
}

export interface PhaseAbortedEvent extends RunEventBase {
  event: 'phase.aborted';
  phase: string;
  phaseIdx: number;
  reason: 'user-interrupt' | 'budget-exceeded' | 'lock-takeover' | 'crash';
}

export interface PhaseCostEvent extends RunEventBase {
  event: 'phase.cost';
  phase: string;
  phaseIdx: number;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export interface PhaseExternalRefEvent extends RunEventBase {
  event: 'phase.externalRef';
  phase: string;
  phaseIdx: number;
  ref: ExternalRef;
}

export interface PhaseNeedsHumanEvent extends RunEventBase {
  event: 'phase.needs-human';
  phase: string;
  phaseIdx: number;
  reason: string;
  /** Hint surfaced to the user / CI consumer. */
  nextActions?: string[];
}

export interface LockTakeoverEvent extends RunEventBase {
  event: 'lock.takeover';
  /** Identity of the writer who previously held the lock (best-effort —
   *  may be null if metadata was missing). */
  previousWriter: WriterId | null;
  reason: string;
}

export interface IndexRebuiltEvent extends RunEventBase {
  event: 'index.rebuilt';
  /** Why the rebuild was needed: "missing", "corrupt", or "force". */
  cause: 'missing' | 'corrupt' | 'force';
}

/** Phase 4 — budget enforcement preflight. Emitted by `runPhase` BEFORE
 *  `phase.start` for every phase whose parent run carries a `BudgetConfig`.
 *  Carries the full `BudgetCheck` payload from `checkPhaseBudget` so
 *  consumers (cost dashboards, CI) can attribute spend and decisions
 *  without re-running the policy. Per the v6 spec "Budget enforcement"
 *  section + Codex CRITICAL #3 (two-layer guard, layer 2 always runs). */
export interface BudgetCheckEvent extends RunEventBase {
  event: 'budget.check';
  phase: string;
  phaseIdx: number;
  decision: 'proceed' | 'pause' | 'hard-fail';
  /** `estimate.high` from `RunPhase.estimateCost` if it returned a value;
   *  null when the phase doesn't implement estimateCost. Layer 2 (the
   *  mandatory floor) ALWAYS runs regardless. */
  estimatedHigh: number | null;
  /** Sum of every prior `phase.cost` event in this run, in USD. */
  actualSoFar: number;
  /** The reserve the runner deducted against `perRunUSD` for this phase
   *  (Layer 2 floor, expressed in USD). */
  reserveApplied: number;
  /** USD remaining under `perRunUSD` after `actualSoFar` + the larger of
   *  `estimatedHigh` and `reserveApplied`. May be negative on hard-fail. */
  capRemaining: number;
  reason: string;
  /** v6.2.0 — which scope produced the decision. `'phase'` (legacy
   *  default) is the single-phase wrapper path; `'run'` is the
   *  orchestrator's cross-phase mode. Optional only for back-compat
   *  with older events.ndjson files; events emitted on v6.2.0+ always
   *  carry a value. */
  scope?: 'phase' | 'run';
}

/** Phase 6 — emitted when a `forceReplay` override flips a needs-human (or
 *  any other refusal) into a retry. Carries the phase and the refs that
 *  WERE consulted so the durable log shows exactly what was overridden.
 *  Spec: "a `--force-replay` override writes an explicit `replay.override`
 *  event with user-supplied reason." */
export interface ReplayOverrideEvent extends RunEventBase {
  event: 'replay.override';
  phase: string;
  phaseIdx: number;
  /** Free-form user / CI reason for the override. */
  reason: string;
  /** Refs the underlying refusal cited (echoed for triage). */
  refsConsulted: ExternalRef[];
}

// ----------------------------------------------------------------------------
// v7.11.0 — Concurrent subagent dispatch events (PR3/6 of the v7.11.0 spec).
// Spec: docs/superpowers/specs/2026-05-19-v7.11.0-concurrent-subagent-execution-design.md
// (sections "Integration with run-state engine (v6)" + "Budget reservation
// semantics"). Authoritative inventory: 11 event types.
//
// All events are emitted by the scheduler under the per-run serialized event
// writer's exclusive lock (see `serialized-writer.ts`). Subagents never write
// directly to events.ndjson — they stream telemetry to the scheduler via IPC.
// ----------------------------------------------------------------------------

/** Subagent dispatch — emitted AFTER `task.budget_reserved` succeeds and the
 *  worktree is created. Carries the immutable `base_sha` so resume / merge
 *  can verify ancestry against an unforgeable reference. */
export interface TaskStartedEvent extends RunEventBase {
  event: 'task.started';
  task_id: string;
  worktree_path: string;
  branch: string;
  base_sha: string;
  subagent_id: string;
  /** ISO timestamp the subagent process was spawned. */
  dispatched_at: string;
  preflight_cost_estimate_usd: number;
}

/** Budget reservation — emitted atomically with the (replay → check → append
 *  → fsync) critical section under the writer's exclusive lock. Two
 *  concurrent callers cannot both pass the budget check. */
export interface TaskBudgetReservedEvent extends RunEventBase {
  event: 'task.budget_reserved';
  task_id: string;
  reserved_usd: number;
  /** `perRunUSD - reserved_total` AFTER this reservation lands. May be 0,
   *  never negative (would have failed the check). */
  run_budget_remaining_after_reservation_usd: number;
}

/** Mid-execution reservation bump — emitted when telemetry from the subagent
 *  shows actual cost is approaching the reservation. Re-checks `perRunUSD`
 *  under the writer lock; halts the run if exceeded. */
export interface TaskBudgetIncreasedReservationEvent extends RunEventBase {
  event: 'task.budget_increased_reservation';
  task_id: string;
  prior_reserved_usd: number;
  new_reserved_usd: number;
  reason: string;
}

/** Reservation closed — emitted on task completion OR failure. The
 *  `delta_vs_reservation_usd` (positive = under, negative = over) lets
 *  cost-analytics consumers spot estimate drift. */
export interface TaskBudgetReleasedEvent extends RunEventBase {
  event: 'task.budget_released';
  task_id: string;
  actual_cost_usd: number;
  delta_vs_reservation_usd: number;
}

/** Successful subagent exit with commits on the task branch. The
 *  `task_branch_tip_sha` is the IMMUTABLE authoritative ref for all
 *  subsequent merge / resume operations — `task_branch_name` is for
 *  diagnostics only (branch can be tampered with). */
export interface TaskCompletedEvent extends RunEventBase {
  event: 'task.completed';
  task_id: string;
  base_sha: string;
  task_branch_tip_sha: string;
  task_branch_name: string;
  /** Ordered list of commit SHAs `base_sha..tip_sha` (oldest first, from
   *  `git rev-list --reverse`). Empty array implies `task.failed` should
   *  have been emitted with `error_type: 'no_commits'` instead. */
  commit_shas: string[];
  completed_at: string;
  actual_cost_usd: number;
  exit_status: 'success' | 'failure';
}

/** Subagent terminal failure. `error_type` is the resume classifier — see
 *  spec "Resume semantics" for the classification table. */
export interface TaskFailedEvent extends RunEventBase {
  event: 'task.failed';
  task_id: string;
  error_message: string;
  error_type:
    | 'timeout'
    | 'no_commits'
    | 'ancestry_violation'
    | 'budget_exceeded'
    | 'crash'
    | 'other';
  failed_at: string;
  actual_cost_usd: number;
}

/** Cherry-pick chain landed on the integration worktree. The
 *  `feature_branch_sha_after_merge` is recorded so the next merge can
 *  verify preconditions (HEAD matches the last `task.merged`). */
export interface TaskMergedEvent extends RunEventBase {
  event: 'task.merged';
  task_id: string;
  feature_branch_sha_after_merge: string;
  merged_at: string;
}

/** Cherry-pick conflict captured BEFORE `cherry-pick --abort` runs.
 *  Diagnostics are also persisted to `conflict_report_path`
 *  (`.claude/run-state/<run-ulid>/conflicts/<task-id>.md`). */
export interface TaskMergeConflictEvent extends RunEventBase {
  event: 'task.merge_conflict';
  task_id: string;
  conflicting_paths: string[];
  /** Output of `git ls-files -u` — index stages 1/2/3 for each conflicted
   *  path. Free-form lines preserved verbatim. */
  index_stages: string[];
  /** Output of `git status --porcelain`. */
  porcelain: string;
  conflict_report_path: string;
}

/** Merge precondition violation — dirty tree, wrong HEAD, in-progress
 *  cherry-pick / rebase, or ancestry violation at merge time. Halts the
 *  run; user must resolve before resume. */
export interface TaskMergeAbortedEvent extends RunEventBase {
  event: 'task.merge_aborted';
  task_id: string;
  reason: string;
  precondition_violated: string;
  occurred_at: string;
}

/** Subagent exceeded `perSubagentTimeoutMs`. Informational — the resume
 *  classifier requires a paired `task.failed` event with
 *  `error_type: 'timeout'` for terminal classification. */
export interface TaskTimeoutEvent extends RunEventBase {
  event: 'task.timeout';
  task_id: string;
  timeout_ms: number;
  /** `SIGTERM` or `SIGKILL` — set to `SIGKILL` when the 30s grace after
   *  SIGTERM elapsed without process exit. */
  killed_signal: 'SIGTERM' | 'SIGKILL';
}

/** Pre-dispatch budget halt — emitted when `reserve()` finds remaining
 *  budget insufficient for the new task's preflight estimate. The task
 *  never dispatches; the scheduler halts the run with this event as the
 *  terminal record. */
export interface TaskBudgetHaltEvent extends RunEventBase {
  event: 'task.budget_halt';
  task_id: string;
  budget_remaining_usd: number;
  preflight_estimate_usd: number;
}

/** Discriminated union of every event variant. Add new variants here and
 *  the code that switches over `event` will type-error at compile time. */
export type RunEvent =
  | RunStartEvent
  | RunCompleteEvent
  | RunWarningEvent
  | RunRecoveryEvent
  | PhaseStartEvent
  | PhaseSuccessEvent
  | PhaseFailedEvent
  | PhaseAbortedEvent
  | PhaseCostEvent
  | PhaseExternalRefEvent
  | PhaseNeedsHumanEvent
  | LockTakeoverEvent
  | IndexRebuiltEvent
  | BudgetCheckEvent
  | ReplayOverrideEvent
  // v7.11.0 — concurrent subagent dispatch (11 task.* events)
  | TaskStartedEvent
  | TaskBudgetReservedEvent
  | TaskBudgetIncreasedReservationEvent
  | TaskBudgetReleasedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskMergedEvent
  | TaskMergeConflictEvent
  | TaskMergeAbortedEvent
  | TaskTimeoutEvent
  | TaskBudgetHaltEvent;

/** Distributive Omit so the discriminated-union shape is preserved when we
 *  strip the fields the appender fills in. Plain `Omit<RunEvent, ...>`
 *  collapses the union into a single intersection and loses variant-specific
 *  fields — so a literal `{ event: 'phase.cost', costUSD: 1, ... }` would
 *  fail typecheck. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** When appending we don't know `seq`, `ts`, `runId`, `schema_version`,
 *  or `writerId` yet — the appender supplies them. */
export type RunEventInput = DistributiveOmit<
  RunEvent,
  'seq' | 'ts' | 'runId' | 'schema_version' | 'writerId'
>;

// ----------------------------------------------------------------------------
// Top-level index entry (rebuildable cache). Mirrors what `runs list` will
// surface. Persisted at `.guardrail-cache/runs/index.json`.
// ----------------------------------------------------------------------------

export interface RunIndexEntry {
  runId: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  totalCostUSD: number;
  /** Last completed phase name (for `runs list` summary). */
  lastPhase?: string;
  /** True if state.json was synthesized via replay because it was missing
   *  or corrupt at last open. Surfaces as a warning in the UI. */
  recovered?: boolean;
}

export interface RunIndex {
  schema_version: SchemaVersion;
  /** Newest first. */
  runs: RunIndexEntry[];
}
