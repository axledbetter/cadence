// tests/concurrent-dispatch/dep-graph.test.ts
//
// Unit tests for the v7.11.0 dependency-graph foundation.
// Covers the 7 acceptance bullets from issue #188 plus edge cases.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FALLBACK_POLICY,
  buildDepGraph,
  parseAndBuildDepGraph,
  parsePlan,
  resolveTaskReference,
} from '../../src/core/concurrent-dispatch/dep-graph.ts';
import {
  DepGraphCycleError,
  DepGraphResolutionError,
  type DepGraph,
} from '../../src/core/concurrent-dispatch/types.ts';

// ---------------------------------------------------------------------------
// Tiny test helpers
// ---------------------------------------------------------------------------

/** Edge `from -> to` exists iff `dependencies.get(to).has(from)`. */
function hasEdge(g: DepGraph, from: string, to: string): boolean {
  return g.dependencies.get(to)?.has(from) ?? false;
}

function depsOf(g: DepGraph, id: string): string[] {
  return [...(g.dependencies.get(id) ?? new Set())].sort();
}

function taskIds(g: DepGraph): string[] {
  return g.tasks.map((t) => t.id);
}

function makePlan(...tasks: string[]): string {
  return tasks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Acceptance bullet 1: explicit depends_on annotations
// ---------------------------------------------------------------------------

describe('parsePlan + buildDepGraph — explicit depends_on annotations', () => {
  it('builds the correct DAG from explicit annotations', () => {
    const plan = makePlan(
      '### Task 1: Foundation',
      '',
      '**Files:**',
      '- Create: `src/foundation.ts`',
      '',
      '### Task 2: Build on foundation',
      '',
      '**Files:**',
      '- Create: `src/build.ts`',
      '',
      '**depends_on:** Task 1',
      '',
      '### Task 3: Build on both',
      '',
      '**Files:**',
      '- Create: `src/both.ts`',
      '',
      '**depends_on:** Task 1, Task 2',
    );
    const g = parseAndBuildDepGraph(plan);
    assert.deepEqual(taskIds(g), ['1', '2', '3']);
    assert.deepEqual(depsOf(g, '1'), []);
    assert.deepEqual(depsOf(g, '2'), ['1']);
    assert.deepEqual(depsOf(g, '3'), ['1', '2']);
    // Inverse view consistent
    assert.deepEqual([...g.dependents.get('1')!].sort(), ['2', '3']);
    assert.deepEqual([...g.dependents.get('2')!].sort(), ['3']);
  });
});

// ---------------------------------------------------------------------------
// Acceptance bullet 2: NO annotations → strict sequential
// ---------------------------------------------------------------------------

describe('buildDepGraph — no annotations fallback (default policy)', () => {
  it('builds a strict sequential chain when no task has depends_on', () => {
    const plan = makePlan(
      '### Task 1: First',
      '',
      '**Files:**',
      '- Create: `a.ts`',
      '',
      '### Task 2: Second',
      '',
      '**Files:**',
      '- Create: `b.ts`',
      '',
      '### Task 3: Third',
      '',
      '**Files:**',
      '- Create: `c.ts`',
    );
    const g = parseAndBuildDepGraph(plan);
    assert.deepEqual(depsOf(g, '1'), []);
    assert.deepEqual(depsOf(g, '2'), ['1']);
    assert.deepEqual(depsOf(g, '3'), ['2']);
    // Exactly one warning, code 'unannotated-fallback-sequential'
    assert.equal(g.warnings.length, 1);
    assert.equal(g.warnings[0]!.code, 'unannotated-fallback-sequential');
  });

  it('with assumeIndependentWithoutDependsOn=true and no file overlap, no edges', () => {
    const plan = makePlan(
      '### Task 1: First',
      '',
      '**Files:**',
      '- Create: `a.ts`',
      '',
      '### Task 2: Second',
      '',
      '**Files:**',
      '- Create: `b.ts`',
    );
    const g = parseAndBuildDepGraph(plan, {
      assumeIndependentWithoutDependsOn: true,
    });
    assert.deepEqual(depsOf(g, '1'), []);
    assert.deepEqual(depsOf(g, '2'), []);
  });
});

// ---------------------------------------------------------------------------
// Acceptance bullet 3: mixed (some annotated, some not)
// ---------------------------------------------------------------------------

describe('buildDepGraph — mixed annotations', () => {
  it('uses explicit annotations where present and file-overlap for the rest', () => {
    const plan = makePlan(
      '### Task 1: Root',
      '',
      '**Files:**',
      '- Create: `src/lib.ts`',
      '',
      '### Task 2: Annotated',
      '',
      '**Files:**',
      '- Create: `src/two.ts`',
      '',
      '**depends_on:** Task 1',
      '',
      '### Task 3: Unannotated, modifies lib.ts',
      '',
      '**Files:**',
      '- Modify: `src/lib.ts`',
    );
    const g = parseAndBuildDepGraph(plan);
    // Task 2 depends on Task 1 (explicit)
    assert.deepEqual(depsOf(g, '2'), ['1']);
    // Task 3 inherits an implicit create->modify edge from Task 1
    assert.deepEqual(depsOf(g, '3'), ['1']);
    // The implicit-create-modify warning should be present
    const codes = g.warnings.map((w) => w.code).sort();
    assert.ok(codes.includes('implicit-create-modify-dep'));
  });

  it('mixed-with-unannotated-unrelated leaves the unannotated task free', () => {
    const plan = makePlan(
      '### Task 1: Root',
      '',
      '**Files:**',
      '- Create: `src/lib.ts`',
      '',
      '### Task 2: Annotated',
      '',
      '**Files:**',
      '- Create: `src/two.ts`',
      '',
      '**depends_on:** Task 1',
      '',
      '### Task 3: Independent',
      '',
      '**Files:**',
      '- Create: `src/three.ts`',
    );
    const g = parseAndBuildDepGraph(plan);
    assert.deepEqual(depsOf(g, '3'), []);
  });
});

// ---------------------------------------------------------------------------
// Acceptance bullet 4: cycle detection
// ---------------------------------------------------------------------------

describe('buildDepGraph — cycle detection', () => {
  it('throws DepGraphCycleError with the full cycle path enumerated', () => {
    const plan = makePlan(
      '### Task 1: A',
      '',
      '**depends_on:** Task 3',
      '',
      '### Task 2: B',
      '',
      '**depends_on:** Task 1',
      '',
      '### Task 3: C',
      '',
      '**depends_on:** Task 2',
    );
    assert.throws(
      () => parseAndBuildDepGraph(plan),
      (err: unknown) => {
        assert.ok(err instanceof DepGraphCycleError);
        // Path enumerated: should mention all three task ids
        const ids = err.cyclePath;
        assert.ok(ids.includes('1'));
        assert.ok(ids.includes('2'));
        assert.ok(ids.includes('3'));
        // First and last are the same (closed cycle)
        assert.equal(ids[0], ids[ids.length - 1]);
        // Error message includes the arrow form
        assert.match(err.message, /Dependency cycle detected:/);
        assert.match(err.message, /->/);
        return true;
      },
    );
  });

  it('detects 2-task self-referential cycle', () => {
    const plan = makePlan(
      '### Task 1: A',
      '',
      '**depends_on:** Task 2',
      '',
      '### Task 2: B',
      '',
      '**depends_on:** Task 1',
    );
    assert.throws(() => parseAndBuildDepGraph(plan), DepGraphCycleError);
  });
});

// ---------------------------------------------------------------------------
// Acceptance bullet 5: fuzzy task-name resolution
// ---------------------------------------------------------------------------

describe('resolveTaskReference — fuzzy name resolution', () => {
  const tasks = parsePlan(
    makePlan(
      '### Task 1: Foundation',
      '',
      '### Task 2: Build',
      '',
      '### Task 3: Polish',
    ),
  );

  it('matches by number alone (no name)', () => {
    const r = resolveTaskReference('Task 1', tasks, '99');
    assert.equal(r.taskId, '1');
    assert.equal(r.reason, 'exact');
  });

  it('matches "Task 1: Foundation" exactly (case-insensitive)', () => {
    const r = resolveTaskReference('Task 1: foundation', tasks, '99');
    assert.equal(r.taskId, '1');
    assert.equal(r.reason, 'exact');
  });

  it('matches "Task 1: anything-else" fuzzily by number', () => {
    const r = resolveTaskReference('Task 1: SomeOtherName', tasks, '99');
    assert.equal(r.taskId, '1');
    assert.equal(r.reason, 'fuzzy');
  });

  it('accepts bare numeric reference', () => {
    const r = resolveTaskReference('3', tasks, '99');
    assert.equal(r.taskId, '3');
  });

  it('throws on nonexistent task number', () => {
    assert.throws(
      () => resolveTaskReference('Task 99', tasks, '1'),
      DepGraphResolutionError,
    );
  });

  it('throws when a task depends on itself', () => {
    assert.throws(
      () => resolveTaskReference('Task 2', tasks, '2'),
      /cannot depend on itself/,
    );
  });

  it('emits a fuzzy-name-resolved warning on the graph when used in depends_on', () => {
    const plan = makePlan(
      '### Task 1: Real Name',
      '',
      '### Task 2: Dependent',
      '',
      '**depends_on:** Task 1: Wrong Name',
    );
    const g = parseAndBuildDepGraph(plan);
    const codes = g.warnings.map((w) => w.code);
    assert.ok(codes.includes('fuzzy-name-resolved'));
    assert.deepEqual(depsOf(g, '2'), ['1']);
  });
});

// ---------------------------------------------------------------------------
// Acceptance bullet 6: implicit dep injection from file overlap
// ---------------------------------------------------------------------------

describe('buildDepGraph — implicit dep injection', () => {
  it('Task B modifies a file Task A creates -> A blocks B', () => {
    const plan = makePlan(
      '### Task 1: Creator',
      '',
      '**Files:**',
      '- Create: `src/x.ts`',
      '',
      '**depends_on:**',
      '',
      '### Task 2: Modifier',
      '',
      '**Files:**',
      '- Modify: `src/x.ts`',
      '',
      '**depends_on:**',
    );
    const g = parseAndBuildDepGraph(plan);
    assert.ok(hasEdge(g, '1', '2'), 'expected implicit edge 1 -> 2');
  });

  it('multi-direction: Task A creates X, Task B modifies X => A blocks B regardless of plan order', () => {
    // The same plan with Task B declared FIRST in the markdown but creating
    // happens in Task A: the create-modify edge should still point A -> B.
    const plan = makePlan(
      '### Task 1: Modifies x',
      '',
      '**Files:**',
      '- Modify: `src/x.ts`',
      '',
      '**depends_on:**',
      '',
      '### Task 2: Creates x',
      '',
      '**Files:**',
      '- Create: `src/x.ts`',
      '',
      '**depends_on:**',
    );
    const g = parseAndBuildDepGraph(plan);
    // Creator (Task 2) -> Modifier (Task 1)
    assert.ok(hasEdge(g, '2', '1'), 'expected implicit edge 2 -> 1');
  });

  it('path normalization: ./foo.ts and foo.ts are the same path', () => {
    const plan = makePlan(
      '### Task 1: Creator',
      '',
      '**Files:**',
      '- Create: `./src/x.ts`',
      '',
      '**depends_on:**',
      '',
      '### Task 2: Modifier',
      '',
      '**Files:**',
      '- Modify: `src/x.ts`',
      '',
      '**depends_on:**',
    );
    const g = parseAndBuildDepGraph(plan);
    assert.ok(hasEdge(g, '1', '2'));
  });

  it('no overlap -> no implicit edges', () => {
    const plan = makePlan(
      '### Task 1: Creator',
      '',
      '**Files:**',
      '- Create: `src/x.ts`',
      '',
      '**depends_on:**',
      '',
      '### Task 2: Different file',
      '',
      '**Files:**',
      '- Create: `src/y.ts`',
      '',
      '**depends_on:**',
    );
    const g = parseAndBuildDepGraph(plan);
    assert.deepEqual(depsOf(g, '1'), []);
    assert.deepEqual(depsOf(g, '2'), []);
  });

  it('strips line-range annotations from paths when matching', () => {
    const plan = makePlan(
      '### Task 1: Creator',
      '',
      '**Files:**',
      '- Create: `src/x.ts`',
      '',
      '**depends_on:**',
      '',
      '### Task 2: Modifier with range',
      '',
      '**Files:**',
      '- Modify: `src/x.ts:42-60`',
      '',
      '**depends_on:**',
    );
    const g = parseAndBuildDepGraph(plan);
    assert.ok(hasEdge(g, '1', '2'));
  });
});

// ---------------------------------------------------------------------------
// Acceptance bullet 7: fallback policy decision tree
// ---------------------------------------------------------------------------

describe('Fallback policy — decision tree', () => {
  it('zero annotations + assumeIndependent=false => strict sequential', () => {
    const plan = makePlan(
      '### Task 1: A',
      '',
      '### Task 2: B',
      '',
      '### Task 3: C',
    );
    const g = buildDepGraph(parsePlan(plan), {
      assumeIndependentWithoutDependsOn: false,
    });
    assert.deepEqual(depsOf(g, '2'), ['1']);
    assert.deepEqual(depsOf(g, '3'), ['2']);
  });

  it('zero annotations + assumeIndependent=true + file overlap => only overlap edges', () => {
    const plan = makePlan(
      '### Task 1: Creator',
      '',
      '**Files:**',
      '- Create: `src/x.ts`',
      '',
      '### Task 2: Modifier',
      '',
      '**Files:**',
      '- Modify: `src/x.ts`',
      '',
      '### Task 3: Unrelated',
      '',
      '**Files:**',
      '- Create: `src/y.ts`',
    );
    const g = buildDepGraph(parsePlan(plan), {
      assumeIndependentWithoutDependsOn: true,
    });
    // 1 -> 2 (create-modify), 3 free
    assert.ok(hasEdge(g, '1', '2'));
    assert.deepEqual(depsOf(g, '3'), []);
    assert.deepEqual(depsOf(g, '1'), []);
  });

  it('at-least-one annotation flips off the sequential fallback', () => {
    const plan = makePlan(
      '### Task 1: A',
      '',
      '### Task 2: B',
      '',
      '**depends_on:**',
      '',
      '### Task 3: C',
    );
    // Task 2 has an annotation (empty); Task 3 does not. Fallback policy
    // should NOT trigger because annotatedCount >= 1.
    const g = parseAndBuildDepGraph(plan);
    assert.deepEqual(depsOf(g, '2'), []);
    assert.deepEqual(depsOf(g, '3'), []);
  });

  it('default policy is "sequential" (matches DEFAULT_FALLBACK_POLICY)', () => {
    assert.equal(DEFAULT_FALLBACK_POLICY.assumeIndependentWithoutDependsOn, false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases — empty, single, malformed
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('empty plan -> empty graph (no crash)', () => {
    const g = parseAndBuildDepGraph('');
    assert.deepEqual(g.tasks, []);
    assert.equal(g.dependencies.size, 0);
    assert.equal(g.warnings.length, 0);
  });

  it('plan with no task headings -> empty graph', () => {
    const g = parseAndBuildDepGraph(
      '# Some plan\n\nSome prose with no `### Task N:` headings.',
    );
    assert.deepEqual(g.tasks, []);
  });

  it('single task -> trivial graph, no edges, no fallback warning', () => {
    const plan = '### Task 1: Only one\n\n**Files:**\n- Create: `a.ts`\n';
    const g = parseAndBuildDepGraph(plan);
    assert.equal(g.tasks.length, 1);
    assert.deepEqual(depsOf(g, '1'), []);
    assert.equal(g.warnings.length, 0);
  });

  it('duplicate task ids throw at parse time', () => {
    const plan = makePlan('### Task 1: A', '', '### Task 1: B');
    assert.throws(() => parsePlan(plan), /duplicate task id/);
  });

  it('depends_on referencing a nonexistent task throws DepGraphResolutionError', () => {
    const plan = makePlan(
      '### Task 1: A',
      '',
      '### Task 2: B',
      '',
      '**depends_on:** Task 99',
    );
    assert.throws(() => parseAndBuildDepGraph(plan), DepGraphResolutionError);
  });

  it('CRLF line endings parse the same as LF', () => {
    const plan = [
      '### Task 1: A',
      '',
      '**Files:**',
      '- Create: `a.ts`',
      '',
      '### Task 2: B',
      '',
      '**Files:**',
      '- Create: `b.ts`',
      '',
      '**depends_on:** Task 1',
    ].join('\r\n');
    const g = parseAndBuildDepGraph(plan);
    assert.deepEqual(depsOf(g, '2'), ['1']);
  });

  it('Task body without a **Files:** block parses with empty file lists', () => {
    const plan = makePlan(
      '### Task 1: Bare',
      '',
      'Just some prose, no Files block.',
      '',
      '### Task 2: Annotated',
      '',
      '**depends_on:** Task 1',
    );
    const g = parseAndBuildDepGraph(plan);
    assert.equal(g.tasks[0]!.creates.length, 0);
    assert.deepEqual(depsOf(g, '2'), ['1']);
  });

  it('handles multiple Modify/Create rules in the Files block', () => {
    const plan = makePlan(
      '### Task 1: Multi',
      '',
      '**Files:**',
      '- Create: `src/a.ts`',
      '- Create: `src/b.ts`',
      '- Modify: `src/c.ts`',
      '- Test: `tests/a.test.ts`',
      '',
      '**depends_on:**',
    );
    const tasks = parsePlan(plan);
    assert.deepEqual(tasks[0]!.creates.sort(), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(tasks[0]!.modifies, ['src/c.ts']);
    assert.deepEqual(tasks[0]!.tests, ['tests/a.test.ts']);
  });

  it('multi-touch file-overlap warns and sequences in plan-declaration order', () => {
    const plan = makePlan(
      '### Task 1: First',
      '',
      '**Files:**',
      '- Modify: `src/shared.ts`',
      '',
      '**depends_on:**',
      '',
      '### Task 2: Second',
      '',
      '**Files:**',
      '- Modify: `src/shared.ts`',
      '',
      '**depends_on:**',
    );
    const g = parseAndBuildDepGraph(plan);
    assert.ok(hasEdge(g, '1', '2'));
    const codes = g.warnings.map((w) => w.code);
    assert.ok(codes.includes('file-overlap-no-explicit-dep'));
  });
});
