---
name: writing-plans
description: Write an implementation plan from an approved spec — task-by-task breakdown with files-to-change, step checkboxes, and (v7.11.0+) optional depends_on annotations for concurrent subagent dispatch. Use when the user has an approved spec and needs a plan ready for /implement or claude-autopilot Step 3.
---

# Writing plans

A plan turns an approved spec into a sequence of executable tasks. Each task
is the atomic unit dispatched to one subagent. Tasks declare the files they
touch, the steps the subagent should perform, and optionally the other tasks
they depend on (v7.11.0+).

> **For the underlying brainstorming + spec flow**, see
> `superpowers:brainstorming` and `superpowers:writing-plans` from the
> superpowers plugin. This document is the claude-autopilot-side companion
> covering the `depends_on:` annotation introduced in v7.11.0 and the
> fallback policy that governs how it interacts with concurrent dispatch.

## Plan file shape

Plans live at `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`. Top-level
structure:

```markdown
# <Topic> Implementation Plan

> **For agentic workers:** Use claude-autopilot Step 3 (concurrent dispatch)
> or superpowers:subagent-driven-development to execute this plan task-by-task.

**Goal:** <one-paragraph statement>
**Architecture:** <one-paragraph statement>
**Tech Stack:** <brief notes>

---

### Task 1: <task name>

**Files:**
- Create: `src/foo.ts`
- Test: `tests/foo.test.ts`

- [ ] **Step 1: <step name>**

<step content — code blocks, instructions, etc.>

- [ ] **Step 2: <step name>**

<more content>

### Task 2: <task name>

**Files:**
- Modify: `src/bar.ts`

- [ ] **Step 1: ...**
```

Each task has:
- A heading `### Task N: <name>` (numbered case-sensitively; the name is
  human-readable and may be fuzzy-matched in `depends_on:` references).
- A `**Files:**` block listing files this task creates, modifies, or tests.
- One or more `- [ ] **Step N: ...**` checkboxes the subagent ticks as it
  implements.

## `depends_on:` annotation (v7.11.0+)

To enable concurrent execution, annotate tasks that depend on other tasks.
The annotation goes on its own line in the task header, after `**Files:**`:

```markdown
### Task 3: Wire foo into bar

**Files:**
- Modify: `src/bar.ts`
- Modify: `src/foo.ts:42-60`

**depends_on:** Task 1, Task 2

- [ ] **Step 1: ...**
```

### Rules

- `depends_on:` is **optional**. If absent, the scheduler infers
  dependencies from file overlap (two tasks touching the same path become a
  sequential pair, ordered by plan-declaration index).
- References are by `### Task N: <name>` heading. **The task number is
  matched case-sensitively; the name is fuzzy-matched** so minor wording
  drift between the reference and the heading is tolerated.
- Multiple deps are comma-separated: `**depends_on:** Task 1, Task 2`.
- Cycles are a **hard error**. The scheduler surfaces the cycle path and
  refuses to dispatch.
- A task that **modifies** a file another task **creates** has an implicit
  dependency on the creating task — the scheduler injects it automatically,
  even without an explicit annotation.
- File overlap without an explicit `depends_on:` produces a **warning**, not
  an error. The scheduler treats overlapping tasks as a sequential pair in
  plan-declaration order. Surfaced in the run report so the user can add an
  explicit annotation if the inferred ordering was wrong.

## Fallback policy (single source of truth)

The fallback policy lives in `src/core/concurrent-dispatch/dep-graph.ts`
(`DEFAULT_FALLBACK_POLICY` + `buildDepGraph`) and is mirrored in
`skills/autopilot/SKILL.md` Step 3:

1. **`concurrency.maxParallelSubagents: 1`** → sequential dispatch.
   Reproduces v7.10.0 behavior exactly. Use this as the escape hatch.
2. **ZERO tasks in the plan have `depends_on:`** → sequential by default.
   Existing plans without annotations are never silently parallelized.
   Override with `concurrency.assumeIndependentWithoutDependsOn: true` to
   opt in to file-overlap inference for an unannotated plan.
3. **At least one task has `depends_on:`** → use the explicit deps + fall
   back to file-overlap inference for the remaining unannotated tasks.

Cycle detection runs in all three cases before dispatch begins.

## Example — mixed annotated + unannotated tasks

```markdown
# Banking integration plan

**Goal:** wire Fiserv adapter into the data sync pipeline.
**Architecture:** adapter under app/services/banking-integrations/adapters,
sync orchestrator under inbound/, compliance check piggy-backs on the sync.

---

### Task 1: Fiserv adapter skeleton

**Files:**
- Create: `app/services/banking-integrations/adapters/fiserv.adapter.ts`
- Test: `app/services/banking-integrations/adapters/__tests__/fiserv.adapter.test.ts`

- [ ] **Step 1: Define the adapter class extending BaseBankingAdapter.**

### Task 2: Borrower-matcher service

**Files:**
- Create: `app/services/banking-integrations/inbound/borrower-matcher.service.ts`
- Test: `app/services/banking-integrations/inbound/__tests__/borrower-matcher.service.test.ts`

- [ ] **Step 1: Implement EIN-then-name-then-email matching.**

### Task 3: Wire adapter into data sync

**Files:**
- Modify: `app/services/banking-integrations/inbound/bank-data-sync.service.ts`
- Modify: `app/services/banking-integrations/adapters/fiserv.adapter.ts`

**depends_on:** Task 1, Task 2

- [ ] **Step 1: Call the adapter from syncBankData; pipe results through borrower-matcher.**

### Task 4: Update CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Prepend a Banking integration entry under Unreleased.**
```

How the scheduler resolves this plan with `maxParallelSubagents: 3` and
`assumeIndependentWithoutDependsOn: false`:

- Task 1 and Task 2 declare no overlap with each other and have no
  `depends_on:`, but Task 3 declares `depends_on: Task 1, Task 2` — so the
  plan has at least one annotation, the explicit-deps + file-overlap
  inference branch is used.
- Tier 0: `Task 1, Task 2, Task 4` (no satisfied deps, no overlap with each
  other) — dispatched in parallel up to `maxParallelSubagents`.
- Tier 1: `Task 3` — eligible only after Tasks 1 and 2 reach state
  `merged`.

If you remove the `**depends_on:** Task 1, Task 2` line from Task 3, the
plan has zero annotations, falls back to sequential dispatch, and runs
Tasks 1 → 2 → 3 → 4 in plan-declaration order — reproducing v7.10.0
behavior.

## When NOT to annotate

- The plan is small (≤ 3 tasks) and the wall-clock gain is not worth the
  annotation maintenance cost.
- All tasks touch the same handful of files (high overlap, no
  parallelizable structure).
- You want to ship the plan against v7.10.0 with the
  `concurrency.maxParallelSubagents: 1` escape hatch and add annotations in
  a follow-up.
