// src/core/concurrent-dispatch/dep-graph.ts
//
// Plan-markdown parser, DAG construction, cycle detection, implicit-dep
// injection, and fallback-policy decision tree for the v7.11.0 concurrent
// subagent dispatch foundation.
//
// PR 1 of 6 — this file is the foundation that scheduler / merge orchestrator
// (later PRs) consume. It performs NO git or filesystem mutations; it only
// reads a plan markdown string and produces a `DepGraph`.
//
// Spec: docs/superpowers/specs/2026-05-19-v7.11.0-concurrent-subagent-execution-design.md
//   - "Annotation fallback policy"
//   - "Plan format extension (depends_on)"

import {
  type DepGraph,
  DepGraphCycleError,
  DepGraphResolutionError,
  type DepGraphWarning,
  type FallbackPolicy,
  type TaskNode,
} from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Default fallback policy: when ZERO tasks have `depends_on:`, fall back to
 * strict sequential execution. This is the conservative, backwards-compatible
 * choice (v7.10.0 behavior). Frozen to prevent process-wide drift from
 * accidental consumer mutation.
 */
export const DEFAULT_FALLBACK_POLICY: FallbackPolicy = Object.freeze({
  assumeIndependentWithoutDependsOn: false,
}) satisfies FallbackPolicy;

/**
 * Parse a plan markdown string into a list of `TaskNode`s in
 * plan-declaration order. Does NOT build the DAG — call `buildDepGraph` for
 * that. Returns an empty array when no `### Task N:` headings are found
 * (callers should treat that as "empty plan").
 *
 * The parser is intentionally permissive about surrounding markdown: it
 * locates `### Task N:` headings via regex on each line and slices the body
 * between consecutive headings. Anything outside a task body is ignored.
 */
export function parsePlan(planMarkdown: string): TaskNode[] {
  const lines = planMarkdown.split(/\r?\n/);

  // Find every `### Task N: <name>` heading. Capture line index so we can
  // slice body lines between consecutive headings deterministically.
  const headings: Array<{ line: number; id: string; name: string }> = [];
  const headingRe = /^### Task (\d+):\s*(.+?)\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const m = headingRe.exec(lines[i] ?? '');
    if (m !== null) {
      headings.push({ line: i, id: m[1]!, name: m[2]! });
    }
  }

  // Reject duplicate task ids — the dep graph keys on id, so collisions
  // would silently overwrite. Surface as a clear error.
  const seen = new Set<string>();
  for (const h of headings) {
    if (seen.has(h.id)) {
      throw new DepGraphResolutionError(
        `Task ${h.id}`,
        h.id,
        `duplicate task id; each task heading must have a unique number`,
      );
    }
    seen.add(h.id);
  }

  const tasks: TaskNode[] = [];
  for (let idx = 0; idx < headings.length; idx++) {
    const start = headings[idx]!.line;
    const end = idx + 1 < headings.length ? headings[idx + 1]!.line : lines.length;
    const body = lines.slice(start + 1, end);
    const { creates, modifies, tests } = parseFilesBlock(body);
    const declaredDependsOn = parseDependsOn(body);
    tasks.push({
      id: headings[idx]!.id,
      name: headings[idx]!.name,
      planIndex: idx,
      creates,
      modifies,
      tests,
      declaredDependsOn,
    });
  }

  return tasks;
}

/**
 * Build a dependency DAG from a parsed task list and a fallback policy.
 *
 * Algorithm (matches spec "Annotation fallback policy"):
 * 1. Resolve every task's `declaredDependsOn` into concrete task ids via
 *    {@link resolveTaskReference}. This is the "explicit" layer.
 * 2. Inject implicit edges from file overlap:
 *    - If Task B `modifies` a path Task A `creates`, add `A -> B`.
 *    - If Task A and Task B both touch the same path (creates OR modifies)
 *      and neither already depends on the other, add an edge from the
 *      earlier-declared task to the later one and emit a warning.
 * 3. If ZERO tasks had ANY `depends_on:` annotation AND
 *    `assumeIndependentWithoutDependsOn` is false: replace the graph with
 *    a strictly-sequential chain (each task depends on the previous one).
 *    This is the "no annotations -> sequential" fallback that preserves
 *    v7.10.0 behavior. If the flag is true, keep file-overlap edges only.
 * 4. Run cycle detection (DFS with three-color marking). Throw
 *    `DepGraphCycleError` with the cycle path on detection.
 *
 * Returns a `DepGraph` whose maps callers should treat as read-only;
 * mutating downstream is a defect.
 */
export function buildDepGraph(
  tasks: TaskNode[],
  policy: FallbackPolicy = DEFAULT_FALLBACK_POLICY,
): DepGraph {
  // Validate uniqueness up-front: this function is exported and reachable
  // by callers that construct `TaskNode[]` directly (not via parsePlan). A
  // duplicate id would silently overwrite earlier map entries and corrupt
  // the graph for the scheduler downstream.
  const seenIds = new Set<string>();
  for (const t of tasks) {
    if (seenIds.has(t.id)) {
      throw new DepGraphResolutionError(
        `Task ${t.id}`,
        t.id,
        `duplicate task id; each TaskNode passed to buildDepGraph must have a unique id`,
      );
    }
    seenIds.add(t.id);
  }

  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  const warnings: DepGraphWarning[] = [];

  for (const t of tasks) {
    dependencies.set(t.id, new Set());
    dependents.set(t.id, new Set());
  }

  // Trivial empty / single-task graphs short-circuit (no edges possible).
  // Freeze the outer container AND the arrays on these paths too for
  // consistency with the full-build path below. (See the closing return
  // for the rationale on which fields get frozen and which don't.)
  if (tasks.length === 0) {
    return freezeGraph(tasks, dependencies, dependents, warnings);
  }
  if (tasks.length === 1) {
    return freezeGraph(tasks, dependencies, dependents, warnings);
  }

  // ---- Layer 1: explicit `depends_on:` annotations ----
  const byId = new Map<string, TaskNode>();
  for (const t of tasks) byId.set(t.id, t);

  // Count only tasks whose annotation contains at least one non-empty
  // reference. An empty `**depends_on:**` line is treated as "no real
  // declaration" so it doesn't flip off the strict-sequential fallback.
  // (Without this, a single empty annotation would silently enable
  // file-overlap inference for an otherwise unannotated plan.)
  let annotatedCount = 0;
  for (const t of tasks) {
    if (t.declaredDependsOn === undefined) continue;
    const hasNonEmptyRef = t.declaredDependsOn.some((r) => r.trim() !== '');
    if (hasNonEmptyRef) annotatedCount += 1;
    for (const rawRef of t.declaredDependsOn) {
      const ref = rawRef.trim();
      if (ref === '') continue;
      const resolved = resolveTaskReference(ref, tasks, t.id);
      if (resolved.reason === 'fuzzy') {
        warnings.push({
          code: 'fuzzy-name-resolved',
          message: `depends_on "${ref}" in Task ${t.id} matched Task ${resolved.taskId} by number; the name portion was ignored`,
          taskIds: [t.id, resolved.taskId],
        });
      }
      addEdge(dependencies, dependents, resolved.taskId, t.id);
    }
  }

  // ---- Layer 2: implicit edges from file overlap ----
  // Build path -> creators / touchers index. Paths are already normalized
  // by `parseFilesBlock`.
  //
  // Only `creates` and `modifies` count as write-like touches for the
  // overlap heuristic. `tests` is intentionally excluded: a Test bullet
  // names a validation target, not a write contention, and including it
  // would over-serialize tasks that merely share a test target.
  const creators = new Map<string, string[]>(); // path -> [taskId...]
  const touchers = new Map<string, string[]>(); // path -> [taskId...] (creates+modifies only)
  for (const t of tasks) {
    for (const p of t.creates) {
      pushUnique(creators, p, t.id);
      pushUnique(touchers, p, t.id);
    }
    for (const p of t.modifies) {
      pushUnique(touchers, p, t.id);
    }
  }

  // Create -> Modify edges (the canonical implicit-dep heuristic from the
  // spec acceptance criteria).
  for (const t of tasks) {
    for (const p of t.modifies) {
      const cs = creators.get(p);
      if (cs === undefined) continue;
      for (const creatorId of cs) {
        if (creatorId === t.id) continue;
        if (addEdge(dependencies, dependents, creatorId, t.id)) {
          warnings.push({
            code: 'implicit-create-modify-dep',
            message: `Task ${t.id} modifies "${p}" which Task ${creatorId} creates; implicit dependency injected`,
            taskIds: [creatorId, t.id],
          });
        }
      }
    }
  }

  // Create -> Test edges (read-after-write hazard, Codex pass 2 finding):
  // if Task A creates `tests/foo.test.ts` and Task B lists the same path
  // under `Test:`, Task B must wait for Task A so the test file exists
  // before B references it. Use a distinct warning code so downstream
  // consumers (UI, metrics, suppression rules) can differentiate this
  // semantics from Create -> Modify write conflicts. We deliberately do
  // NOT do the same for Modify -> Test (modifying an existing test file
  // doesn't change existence semantics) and NOT for Test/Test pairs
  // (same-target sharing is not a write hazard).
  for (const t of tasks) {
    for (const p of t.tests) {
      const cs = creators.get(p);
      if (cs === undefined) continue;
      for (const creatorId of cs) {
        if (creatorId === t.id) continue;
        if (addEdge(dependencies, dependents, creatorId, t.id)) {
          warnings.push({
            code: 'implicit-create-test-dep',
            message: `Task ${t.id} references test "${p}" which Task ${creatorId} creates; implicit dependency injected`,
            taskIds: [creatorId, t.id],
          });
        }
      }
    }
  }

  // Same-path-touch warning: any two tasks that touch the same path without
  // a direct edge in either direction get a warning + a sequential edge in
  // plan-declaration order. This catches "both modify the same file" cases
  // where the user didn't annotate but the order matters.
  for (const [p, ts] of touchers) {
    if (ts.length < 2) continue;
    // Sort by planIndex to ensure deterministic edge direction.
    const sorted = ts
      .map((id) => byId.get(id)!)
      .sort((a, b) => a.planIndex - b.planIndex);
    for (let i = 0; i < sorted.length - 1; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]!;
        const b = sorted[j]!;
        if (hasPath(dependencies, a.id, b.id) || hasPath(dependencies, b.id, a.id)) {
          continue;
        }
        if (addEdge(dependencies, dependents, a.id, b.id)) {
          warnings.push({
            code: 'file-overlap-no-explicit-dep',
            message: `Tasks ${a.id} and ${b.id} both touch "${p}" without explicit depends_on; treating as sequential (${a.id} -> ${b.id}) by plan order`,
            taskIds: [a.id, b.id],
          });
        }
      }
    }
  }

  // ---- Layer 3: zero-annotation fallback policy ----
  // If NO task had a `depends_on:` annotation AND the policy says to assume
  // sequential, overwrite the graph with a strict chain. We do this AFTER
  // file-overlap inference so the warning list is empty in this branch
  // (file-overlap warnings about "treated as sequential" would be misleading
  // when we're about to make EVERYTHING sequential anyway).
  if (annotatedCount === 0 && !policy.assumeIndependentWithoutDependsOn) {
    // Reset edges and warnings; rebuild as a strict chain in plan order.
    for (const t of tasks) {
      dependencies.set(t.id, new Set());
      dependents.set(t.id, new Set());
    }
    warnings.length = 0;
    for (let i = 1; i < tasks.length; i++) {
      addEdge(dependencies, dependents, tasks[i - 1]!.id, tasks[i]!.id);
    }
    warnings.push({
      code: 'unannotated-fallback-sequential',
      message: `No tasks declared depends_on; defaulting to strict sequential execution (${tasks.length} tasks). Set concurrency.assumeIndependentWithoutDependsOn: true to opt in to file-overlap inference.`,
      taskIds: tasks.map((t) => t.id),
    });
  }

  // ---- Layer 4: cycle detection ----
  const cycle = findCycle(tasks, dependencies);
  if (cycle !== null) {
    throw new DepGraphCycleError(cycle);
  }

  // Lightweight runtime immutability for the outer graph container plus
  // the `tasks` and `warnings` arrays (cheap to freeze; consumers might
  // reasonably try `g.warnings.push(...)` or `g.tasks.sort()` at the
  // boundary). The inner `Map`/`Set` instances remain mutable at runtime
  // (deep-freezing every set/map would be hot-path overhead the scheduler
  // doesn't need); the type-level `ReadonlyMap`/`ReadonlySet` contract on
  // `DepGraph` is the primary guardrail for those.
  return freezeGraph(tasks, dependencies, dependents, warnings);
}

/**
 * Freeze the outer `DepGraph` container plus the `tasks` and `warnings`
 * arrays. `dependencies` and `dependents` maps are intentionally NOT
 * deep-frozen: type-level `ReadonlyMap`/`ReadonlySet` is the contract for
 * the inner collections, and runtime freezing them would add cost without
 * eliminating the legitimate need to query them via `get`/`has`/etc.
 */
function freezeGraph(
  tasks: TaskNode[],
  dependencies: Map<string, Set<string>>,
  dependents: Map<string, Set<string>>,
  warnings: DepGraphWarning[],
): DepGraph {
  Object.freeze(tasks);
  Object.freeze(warnings);
  return Object.freeze({ tasks, dependencies, dependents, warnings });
}

/**
 * Convenience wrapper: parse + build in one call. Most callers want this.
 */
export function parseAndBuildDepGraph(
  planMarkdown: string,
  policy: FallbackPolicy = DEFAULT_FALLBACK_POLICY,
): DepGraph {
  return buildDepGraph(parsePlan(planMarkdown), policy);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse the `**Files:**` block out of a task body. The block is a markdown
 * bullet list where each bullet starts with `Create:`, `Modify:`, or
 * `Test:` followed by one or more backtick-quoted paths.
 *
 * Spec example:
 *
 * ```markdown
 * **Files:**
 * - Create: `src/foo.ts`
 * - Modify: `src/bar.ts:42-60`
 * - Test: `tests/foo.test.ts`
 * ```
 *
 * The block ends at the next blank line followed by non-list content, or
 * at the next `**Bold:**` heading, whichever comes first. Returns
 * deduplicated, normalized path lists. Line-range annotations
 * (e.g. `:42-60`) are stripped for matching purposes — the file IS the
 * file regardless of which lines change.
 */
function parseFilesBlock(bodyLines: string[]): {
  creates: string[];
  modifies: string[];
  tests: string[];
} {
  const creates = new Set<string>();
  const modifies = new Set<string>();
  const tests = new Set<string>();

  // Locate the **Files:** marker. Case-sensitive on "Files" per the spec
  // example; tolerant of trailing whitespace.
  let i = 0;
  while (i < bodyLines.length) {
    if (/^\s*\*\*Files:\*\*\s*$/.test(bodyLines[i] ?? '')) break;
    i++;
  }
  if (i >= bodyLines.length) {
    return { creates: [], modifies: [], tests: [] };
  }
  i++; // skip the marker line itself

  // Read until we hit another `**Bold:**` block, a `### ` heading (which
  // shouldn't appear inside a task body but be defensive), or end-of-body.
  const itemRe = /^\s*-\s*(Create|Modify|Test):\s*(.+?)\s*$/;
  for (; i < bodyLines.length; i++) {
    const line = bodyLines[i] ?? '';
    if (/^\s*\*\*[A-Za-z][\w ]*:\*\*/.test(line) && !/^\s*\*\*Files:\*\*/.test(line)) {
      break;
    }
    if (/^### /.test(line)) break;
    const m = itemRe.exec(line);
    if (m === null) continue;
    const kind = m[1]!;
    const paths = extractBacktickPaths(m[2]!);
    const bucket =
      kind === 'Create' ? creates : kind === 'Modify' ? modifies : tests;
    for (const p of paths) bucket.add(p);
  }

  return {
    creates: [...creates],
    modifies: [...modifies],
    tests: [...tests],
  };
}

/**
 * Extract backtick-quoted paths from a Files-block item line. Strips the
 * `:lineRange` annotation that the spec example shows (`:42-60`). Falls
 * back to whitespace-splitting the raw text if no backticks are present
 * (defensive — plans in the wild may be informal).
 */
function extractBacktickPaths(s: string): string[] {
  const out: string[] = [];
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(normalizePath(stripLineRange(m[1]!)));
  }
  if (out.length === 0) {
    // No backticks — split on commas/whitespace and accept tokens that look
    // like paths (contain at least one `/` or `.`).
    for (const tok of s.split(/[,\s]+/)) {
      if (tok === '') continue;
      if (tok.includes('/') || tok.includes('.')) {
        out.push(normalizePath(stripLineRange(tok)));
      }
    }
  }
  return out;
}

function stripLineRange(p: string): string {
  // Strip `:N-M` or `:N` suffix (only when it looks numeric so we don't
  // chop Windows drive letters or scoped npm packages).
  return p.replace(/:\d+(-\d+)?$/, '');
}

/**
 * Normalize a path for equality comparison:
 * - Strip leading `./`
 * - Collapse repeated `/`
 * - Drop trailing `/`
 * - Preserve case (filesystems vary; we don't lowercase)
 *
 * `./foo.ts` and `foo.ts` resolve to the same string after this.
 */
function normalizePath(p: string): string {
  let n = p.trim();
  while (n.startsWith('./')) n = n.slice(2);
  n = n.replace(/\/+/g, '/');
  while (n.endsWith('/') && n.length > 1) n = n.slice(0, -1);
  return n;
}

/**
 * Parse a `**depends_on:**` line from a task body. Returns the
 * comma-separated names as written (whitespace untouched, downstream
 * resolution does the trimming).
 *
 * Returns `undefined` when no `**depends_on:**` marker is present in the
 * body. Returns `[]` when the marker is present but the value is empty
 * (e.g., `**depends_on:**` with nothing after). This distinction matters
 * for the fallback policy: an explicitly-empty annotation still counts as
 * "the user annotated this task", flipping the no-annotation branch off.
 *
 * The marker is matched case-insensitively on "depends_on" for robustness;
 * `**Depends_on:**` and `**depends_on:**` both work.
 */
function parseDependsOn(bodyLines: string[]): string[] | undefined {
  const re = /^\s*\*\*depends_on:\*\*\s*(.*?)\s*$/i;
  for (const line of bodyLines) {
    const m = re.exec(line);
    if (m !== null) {
      const value = m[1] ?? '';
      if (value === '') return [];
      return value.split(',').map((s) => s.trim()).filter((s) => s !== '');
    }
  }
  return undefined;
}

/**
 * Resolve a `depends_on:` reference like `Task 3` or `Task 3: Foo` to a
 * concrete task id from the parsed task list.
 *
 * Resolution rules (spec "Plan format extension"):
 * - Numeric portion is REQUIRED and matched exactly: `Task 3` matches
 *   `### Task 3: ...` only.
 * - Name portion is OPTIONAL and matched fuzzily: if absent, the number
 *   alone wins; if present, the parser still resolves by number alone but
 *   surfaces a warning so the user notices a possible typo.
 * - Bare numeric references (`3`) are accepted as a forgiving alias.
 *
 * Throws `DepGraphResolutionError` when:
 * - The reference doesn't match the expected shape
 * - No task has the referenced number
 * - The reference points at the task itself (self-loop)
 */
export function resolveTaskReference(
  reference: string,
  tasks: TaskNode[],
  declaringTaskId: string,
): { taskId: string; reason: 'exact' | 'fuzzy' } {
  // Accept `Task 3`, `Task 3: Anything`, `task 3`, or bare `3`.
  const m = /^\s*(?:task\s+)?(\d+)(?:\s*:\s*(.*))?\s*$/i.exec(reference);
  if (m === null) {
    throw new DepGraphResolutionError(
      reference,
      declaringTaskId,
      `expected "Task N" or "Task N: <name>" (got "${reference}")`,
    );
  }
  const id = m[1]!;
  const namePart = (m[2] ?? '').trim();

  const target = tasks.find((t) => t.id === id);
  if (target === undefined) {
    throw new DepGraphResolutionError(
      reference,
      declaringTaskId,
      `no task with id ${id} in the plan`,
    );
  }
  if (target.id === declaringTaskId) {
    throw new DepGraphResolutionError(
      reference,
      declaringTaskId,
      `a task cannot depend on itself`,
    );
  }
  // Fuzzy reason: the user wrote a name, but we resolved by number alone.
  // Surface a hint for non-exact (case-insensitive) names so the user can
  // catch typos. An empty name part is "exact" (no name to compare).
  if (namePart === '') {
    return { taskId: target.id, reason: 'exact' };
  }
  if (namePart.toLowerCase() === target.name.toLowerCase()) {
    return { taskId: target.id, reason: 'exact' };
  }
  return { taskId: target.id, reason: 'fuzzy' };
}

/**
 * Add an edge `from -> to` to the dependency / dependent maps. Returns
 * `true` if the edge was new, `false` if it already existed.
 */
function addEdge(
  dependencies: Map<string, Set<string>>,
  dependents: Map<string, Set<string>>,
  from: string,
  to: string,
): boolean {
  const deps = dependencies.get(to);
  if (deps === undefined) {
    throw new Error(`internal: dependencies map missing entry for ${to}`);
  }
  if (deps.has(from)) return false;
  deps.add(from);
  const inv = dependents.get(from);
  if (inv === undefined) {
    throw new Error(`internal: dependents map missing entry for ${from}`);
  }
  inv.add(to);
  return true;
}

/**
 * Push a value into a `Map<K, V[]>` only if it isn't already present.
 */
function pushUnique<K, V>(m: Map<K, V[]>, key: K, value: V): void {
  const arr = m.get(key);
  if (arr === undefined) {
    m.set(key, [value]);
    return;
  }
  if (!arr.includes(value)) arr.push(value);
}

/**
 * Does a directed path from `from` to `to` exist in the current graph?
 * Used by the file-overlap-warning step to skip pairs that are already
 * connected (transitively).
 */
function hasPath(
  dependencies: Map<string, Set<string>>,
  from: string,
  to: string,
): boolean {
  if (from === to) return true;
  // dependencies[x] = tasks x depends on. A "path from A to B" in the sense
  // of "A must complete before B" means we walk forward from A toward B.
  // Use the inverse view: a child y of x is any y for which deps(y) has x.
  const visited = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const [id, deps] of dependencies) {
      if (deps.has(cur)) {
        if (id === to) return true;
        stack.push(id);
      }
    }
  }
  return false;
}

/**
 * Find a cycle in the dependency graph using DFS with three-color marking
 * (white = unvisited, gray = on current DFS stack, black = finished).
 * Returns the cycle path (closed loop, first === last) or `null` if the
 * graph is acyclic.
 *
 * Iteration is in plan-declaration order so the reported cycle is stable
 * across runs.
 */
function findCycle(
  tasks: TaskNode[],
  dependencies: Map<string, Set<string>>,
): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();
  for (const t of tasks) {
    color.set(t.id, WHITE);
    parent.set(t.id, null);
  }

  // Forward-edge view: children of `n` are tasks that list `n` in deps.
  const forward = new Map<string, string[]>();
  for (const t of tasks) forward.set(t.id, []);
  for (const [child, deps] of dependencies) {
    for (const par of deps) {
      forward.get(par)?.push(child);
    }
  }
  // Sort forward edges by planIndex for deterministic traversal.
  const byId = new Map<string, TaskNode>();
  for (const t of tasks) byId.set(t.id, t);
  for (const [k, v] of forward) {
    v.sort((a, b) => (byId.get(a)?.planIndex ?? 0) - (byId.get(b)?.planIndex ?? 0));
    forward.set(k, v);
  }

  for (const start of tasks) {
    if (color.get(start.id) !== WHITE) continue;
    // Iterative DFS to avoid stack overflow on pathological plans.
    const stack: Array<{ id: string; iter: number }> = [
      { id: start.id, iter: 0 },
    ];
    color.set(start.id, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = forward.get(frame.id) ?? [];
      if (frame.iter >= children.length) {
        color.set(frame.id, BLACK);
        stack.pop();
        continue;
      }
      const next = children[frame.iter]!;
      frame.iter += 1;
      const c = color.get(next);
      if (c === WHITE) {
        color.set(next, GRAY);
        parent.set(next, frame.id);
        stack.push({ id: next, iter: 0 });
      } else if (c === GRAY) {
        // Cycle: walk parents from `frame.id` back to `next` to enumerate.
        const path: string[] = [next];
        let cur: string | null = frame.id;
        while (cur !== null && cur !== next) {
          path.push(cur);
          cur = parent.get(cur) ?? null;
        }
        path.push(next);
        path.reverse();
        return path;
      }
      // BLACK: already fully explored, no cycle here.
    }
  }
  return null;
}
