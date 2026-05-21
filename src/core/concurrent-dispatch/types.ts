// src/core/concurrent-dispatch/types.ts
//
// Shared types for the v7.11.0 concurrent subagent dispatch foundation.
// PR 1 of 6 — these shapes are consumed by the dep-graph in this PR and by
// the scheduler / merge-orchestrator / locking primitives in later PRs.
//
// Spec: docs/superpowers/specs/2026-05-19-v7.11.0-concurrent-subagent-execution-design.md

/**
 * A task parsed from a plan markdown file. Identified by its `### Task N: <name>`
 * heading. `id` is the numeric portion (`N` as a string for stable ordering),
 * `name` is the human-readable name after the colon.
 *
 * `planIndex` is the zero-based position of the task in the plan's declaration
 * order. The scheduler uses this as the deterministic tie-break when multiple
 * tasks are ready to dispatch in the same tick.
 *
 * `files` enumerates the paths declared in the task body's `**Files:**` block,
 * normalized (leading `./` stripped, separators preserved). They drive the
 * implicit-dep injection heuristic (Task B that *modifies* a path Task A
 * *creates* implicitly depends on Task A).
 *
 * `declaredDependsOn` is the raw (untrimmed-after-comma-split) list of names
 * pulled from the `**depends_on:**` line, if present. It is undefined when no
 * annotation is present (vs. an empty array, which would mean an explicitly
 * empty annotation — the parser preserves that distinction so the fallback
 * policy can count annotations correctly).
 */
export interface TaskNode {
  /** Numeric portion of the `### Task N:` heading as a string. */
  id: string;
  /** Human-readable name after the colon in `### Task N: <name>`. */
  name: string;
  /** Zero-based position in plan-declaration order. */
  planIndex: number;
  /** Files the task creates (normalized paths). */
  creates: string[];
  /** Files the task modifies (normalized paths). */
  modifies: string[];
  /** Test files the task adds (normalized paths). */
  tests: string[];
  /** Raw `depends_on:` names as written, in source order. Undefined = annotation absent. */
  declaredDependsOn: string[] | undefined;
}

/**
 * A "tier" is a set of tasks that are all simultaneously ready to dispatch
 * (i.e., their dependencies are all in the previous or earlier tiers). The
 * scheduler in PR 4 will iterate tiers, dispatching up to
 * `maxParallelSubagents` from each. Tasks within a tier are ordered by
 * `planIndex` for deterministic dispatch order.
 */
export interface Tier {
  /** Zero-based tier index (root tier is 0). */
  index: number;
  /** Task IDs in this tier, ordered by `planIndex` (ascending). */
  taskIds: string[];
}

/**
 * Final outcome of a concurrent dispatch run. Populated by the scheduler
 * (PR 4) and the merge orchestrator (PR 5). Defined here so type imports
 * remain centralized.
 */
export interface DispatchResult {
  /** Run ULID (matches the run-state engine's run id). */
  runId: string;
  /** Tasks that successfully merged onto the feature branch. */
  merged: string[];
  /** Tasks that completed (subagent exited cleanly) but never merged. */
  completedUnmerged: string[];
  /** Tasks that failed (subagent error, timeout, budget halt, etc.). */
  failed: string[];
  /** Tasks that were still in flight when the run halted. */
  inFlight: string[];
  /** Tasks that never started (upstream failure cascaded). */
  notStarted: string[];
}

/**
 * Configuration controlling how the dep-graph parser handles plans without
 * any `depends_on:` annotations.
 *
 * Spec: "Annotation fallback policy".
 *
 * - `assumeIndependentWithoutDependsOn: false` (default): zero annotations
 *   → strict sequential. Every task implicitly depends on the previous task
 *   in plan-declaration order.
 * - `assumeIndependentWithoutDependsOn: true`: zero annotations → use
 *   file-overlap inference only. Tasks with no file overlap run in parallel.
 *
 * If at least one task has a `depends_on:` annotation, this flag is ignored;
 * the parser uses explicit annotations plus file-overlap inference for the
 * remaining unannotated tasks.
 */
export interface FallbackPolicy {
  /** Default `false`. Only consulted when ZERO tasks have `depends_on:`. */
  assumeIndependentWithoutDependsOn: boolean;
}

/**
 * The dependency graph produced by `parsePlan` + `buildDepGraph`. Stored as
 * an adjacency list keyed by task id, where `dependencies[taskId]` is the
 * set of task ids that `taskId` depends on (must complete first).
 *
 * `dependents[taskId]` is the inverse: tasks that depend on `taskId`. The
 * topo sort and Kahn-readiness queries use both directions.
 *
 * `tasks` is the parsed task list in plan-declaration order. The scheduler
 * uses this for deterministic ordering.
 *
 * `warnings` carries non-fatal observations (e.g., file overlap without an
 * explicit `depends_on:` annotation) for the run report.
 */
export interface DepGraph {
  /** Parsed tasks in plan-declaration order. Treat as read-only. */
  readonly tasks: readonly TaskNode[];
  /** `dependencies.get(id)` = task ids that `id` depends on. */
  readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>;
  /** `dependents.get(id)` = task ids that depend on `id` (inverse). */
  readonly dependents: ReadonlyMap<string, ReadonlySet<string>>;
  /** Non-fatal observations surfaced in the run report. */
  readonly warnings: readonly DepGraphWarning[];
}

/**
 * A non-fatal observation from graph construction. The scheduler surfaces
 * these in the run report so the user can add explicit `depends_on:`
 * annotations if a heuristic produced the wrong ordering.
 */
export interface DepGraphWarning {
  /** Stable code for filtering / formatting. */
  code:
    | 'file-overlap-no-explicit-dep'
    | 'fuzzy-name-resolved'
    | 'implicit-create-modify-dep'
    | 'unannotated-fallback-sequential';
  /** Human-readable message for the run report. */
  message: string;
  /** Task ids involved (typically `[fromId, toId]`, but any subset). */
  taskIds: string[];
}

/**
 * Why a `depends_on:` reference resolved to a particular task id. Used by
 * the parser for diagnostics when a name is ambiguous or unmatched.
 */
export type ResolutionReason =
  | 'exact'      // `Task 3` matched `### Task 3: ...`
  | 'fuzzy';     // `Task 3: Foo` matched `### Task 3: Bar` by number only

/**
 * A cycle path enumerated in the order it traverses. Always non-empty when
 * a cycle is detected. The first and last elements are the same task id,
 * marking the cycle's start/end.
 */
export type CyclePath = string[];

/**
 * Thrown by `buildDepGraph` when a cycle is detected. The error message
 * includes the cycle path in human-readable form (e.g., `Task 1 -> Task 2
 * -> Task 1`).
 */
export class DepGraphCycleError extends Error {
  readonly cyclePath: CyclePath;
  constructor(cyclePath: CyclePath) {
    super(`Dependency cycle detected: ${cyclePath.join(' -> ')}`);
    this.name = 'DepGraphCycleError';
    this.cyclePath = cyclePath;
  }
}

/**
 * Thrown by `parsePlan` when a `depends_on:` reference cannot be resolved
 * to a task (e.g., `Task 99` when there are only 3 tasks, or `Task 1` when
 * two tasks share id "1" — which the parser also rejects).
 */
export class DepGraphResolutionError extends Error {
  readonly reference: string;
  readonly taskId: string | undefined;
  constructor(reference: string, taskId: string | undefined, detail: string) {
    super(
      `Cannot resolve depends_on reference "${reference}"` +
        (taskId !== undefined ? ` in Task ${taskId}` : '') +
        `: ${detail}`,
    );
    this.name = 'DepGraphResolutionError';
    this.reference = reference;
    this.taskId = taskId;
  }
}
