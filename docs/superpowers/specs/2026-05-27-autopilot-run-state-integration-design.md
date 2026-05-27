---
title: Wire v6 Run-State Engine Into Autopilot Skill (Checkpoint/Resume)
date: 2026-05-27
risk_tier: high
status: design
related_issue: 180
---

# Wire v6 Run-State Engine Into Autopilot Skill

## Why

Autopilot runs span 30–90 minutes. Mid-flight failures (Mac sleep, network drop, Anthropic 429, Cursor crash) leave the run in unknown state — worktree dirty, impl agent's work maybe committed, codex pass maybe complete. For single-machine setups this is especially painful — one sleep cycle 60min into a run loses all progress.

Cadence **already has 4,873 LOC of checkpoint/resume infrastructure** at `src/core/run-state/` (the v6 run-state engine — see issue #180). It includes deterministic `state.json` + `events.ndjson`, lock manager, ULID run IDs, phase wrapper with idempotency, provider read-back, and `resume-preflight.ts` with the decision matrix (`proceed-fresh | skip-already-applied | retry | needs-human`). The autopilot skill is completely blind to it.

This spec wires the engine into the autopilot skill so every autopilot run is checkpoint-able and resume-able.

## Goal

A user can run `cadence autopilot <spec.md>`, kill the process (or have the machine sleep), and later run `cadence autopilot resume <run-id>` to pick up at the last completed phase boundary without redoing work.

## Non-goals

- Cross-machine resume (the worktree is local; resume only works on the same machine).
- Resume across cadence version upgrades (state schema is versioned; mismatched versions fail loud).
- Per-task (sub-phase) checkpointing inside subagent execution. Phase-boundary granularity only.
- Distributed locking (single-machine `proper-lockfile` is sufficient).

## Architecture

```
cadence autopilot <spec.md>
  ├─ ULID run-id generated
  ├─ run-state dir created: .cadence/runs/<ulid>/
  │      ├── state.json       (current phase, args, profile, started_at)
  │      ├── events.ndjson    (append-only event log)
  │      ├── lock             (proper-lockfile)
  │      └── artifacts/       (PR url, validate report, codex report, etc.)
  └─ each pipeline step (0-9):
       phase.start  → state.currentPhase = "spec" | "plan" | "implement" | ...
       phase.complete → event with output artifact path
       phase.failed → event with error + recovery hint

cadence autopilot resume <ulid>
  ├─ load state.json
  ├─ acquire lock
  ├─ call resume-preflight.decideReplay(state) →
  │      proceed-fresh: re-run current phase from scratch
  │      skip-already-applied: phase actually completed, advance
  │      retry: re-run with same inputs (transient failure)
  │      needs-human: print state + bail
  └─ continue pipeline from resolved phase
```

## Components

### 1. Skill changes (`skills/autopilot/SKILL.md`)

Add ULID emission at step 0:
```
[autopilot] Run started: 01J9X7TBQK7M2W6E4HZGV4K3PB
[autopilot] State dir:   .cadence/runs/01J9X7TBQK7M2W6E4HZGV4K3PB/
```

Each pipeline step (numbered 1–9 in current skill) gets bracketed:
```
[autopilot] Step 3: implement (phase.start)
... work ...
[autopilot] Step 3: implement (phase.complete) → commit abc123 on feature/foo
```

The skill's "Error Recovery" section is replaced with:
```
If a run halts mid-flight:
  $ cadence runs list                  # find the ulid
  $ cadence autopilot resume <ulid>    # resume at last completed phase
The engine refuses to resume if the worktree state diverges from the
recorded artifacts (e.g., user manually committed something after the
crash). In that case the run is marked needs-human and you fix manually.
```

### 2. New module: `src/core/autopilot/run-lifecycle.ts`

Thin wrapper that the autopilot dispatcher calls at each phase boundary:

```typescript
export class AutopilotRun {
  static create(specPath: string, opts: AutopilotOpts): AutopilotRun;
  static resume(runId: string): AutopilotRun;

  beginPhase(phase: PhaseName, input: unknown): void;
  endPhase(phase: PhaseName, output: unknown): void;
  failPhase(phase: PhaseName, err: Error, hint: 'retry'|'needs-human'): void;

  get currentPhase(): PhaseName;
  get runId(): string;
  release(): void;  // release lock
}
```

Internally calls `src/core/run-state/` primitives — does not duplicate them.

### 3. CLI verbs

- `cadence runs list [--status active|complete|failed|all]` — already exists per issue body; verify and wire into autopilot context.
- `cadence runs show <ulid>` — print state.json + last 20 events.
- `cadence runs gc [--keep N]` — already exists; verify the autopilot dispatcher's state dirs are GC-eligible.
- `cadence autopilot resume <ulid>` (new entry point) — loads state, calls `decideReplay`, continues.

### 4. State schema

`.cadence/runs/<ulid>/state.json`:
```json
{
  "schemaVersion": "1.0.0",
  "runId": "01J9X7TBQK7M2W6E4HZGV4K3PB",
  "specPath": "docs/superpowers/specs/2026-05-27-foo.md",
  "branch": "feature/foo",
  "worktreePath": "/Users/alex/work/cadence/.cadence/worktrees/foo",
  "profile": "solo",
  "currentPhase": "implement",
  "completedPhases": ["spec","plan","worktree"],
  "startedAt": "2026-05-27T08:14:22Z",
  "lastEventAt": "2026-05-27T08:31:09Z",
  "artifacts": {
    "spec": "docs/.../foo-design.md",
    "plan": "docs/.../foo.md",
    "pr": null,
    "validateReport": null,
    "codexReport": null
  }
}
```

`events.ndjson` is append-only; each line is `{ts, phase, kind: 'start'|'complete'|'failed', payload}`.

### 5. Phase-boundary contract

Every phase must be idempotent at the boundary — if `phase.complete` was emitted, the work is committed. If `phase.failed` was emitted, the work is rolled back or marked retry-safe. Specifically:

- **spec/plan**: artifact is a committed file → re-run is safe (would just regenerate; resume skips).
- **worktree**: branch exists check → resume skips if branch present.
- **implement**: commits in worktree → resume reads `git log` to confirm work landed before skip-vs-retry decision.
- **migrate**: this is the tricky one — read-back from Supabase to confirm migration applied; if applied, skip; if not, retry (idempotent SQL pattern required).
- **validate**: artifact at `.claude/validation-report.json`; if present and passing, skip.
- **PR**: `gh pr list --head <branch>` to see if PR exists; if yes, skip create.
- **codex/bugbot**: each comment posted has a stable ID; replay is idempotent at the comment-id level.
- **merge**: `gh pr view --json mergedAt`; if merged, run complete.

## Error handling

- Lock held by another process → bail with "another `cadence autopilot` is running for this branch."
- State schema version mismatch (resume across cadence upgrade) → bail with "run was started on cadence vX, current is vY — manual fix required."
- `decideReplay` returns `needs-human` → print state + last 5 events + bail.
- Worktree missing on resume → bail with "worktree at <path> not found; the run cannot resume."
- Profile changed between original run and resume → warn (print diff) and use original.

## Testing

New test file: `tests/autopilot/run-lifecycle.test.ts`

1. Create new run → state.json + lock exist, currentPhase is `spec`.
2. End-to-end happy path: 9 phase-complete events, lock released, final state `complete`.
3. Mid-flight kill: spawn child running autopilot, SIGKILL after `implement` start, run `resume`, verify it picks up at `implement` (decideReplay → retry).
4. Resume after `implement` complete: verify `decideReplay` → skip-already-applied, advances to `migrate`.
5. Worktree divergence: hand-edit a file in worktree post-crash, resume → preflight detects diff → needs-human.
6. Concurrent resume blocked by lock.

Integration test: `tests/autopilot/end-to-end-resume.test.ts` — runs a no-op fake-spec through the full pipeline, kills mid-flight, resumes, asserts final state matches a non-interrupted run.

## Backward compatibility

- Existing autopilot runs (no run-state) still work — emitting events to a state dir is non-blocking.
- `cadence autopilot` without explicit run-id auto-generates one. Resume requires the run-id be provided.
- No changes to spec/plan file format or location.

## Rollout

1. Land run-lifecycle.ts + tests behind a feature flag `CADENCE_RUN_STATE_ENABLED` (default off).
2. Dogfood internally for a week — every cadence release through cadence's own pipeline uses it.
3. Flip default to on in v8.5.0.
4. Update README "Recovery" section.

## Out of scope

- Distributed runs (multi-machine).
- Tarball-based run export (for sharing failed runs with maintainers).
- UI dashboard for active runs.
