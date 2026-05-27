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

### 1. Authoritative boundary lives in the dispatcher, NOT the skill

Per codex CRITICAL: the skill is documentation/UX, not the source of truth. `src/core/autopilot/run-lifecycle.ts` is the ONLY place that begins/completes/fails phases. The skill describes recovery UX and prints user-facing breadcrumbs, but never relies on textual log markers for correctness.

**Skill updates** (`skills/autopilot/SKILL.md`) — UX only:
```
[autopilot] Run started: 01J9X7TBQK7M2W6E4HZGV4K3PB
[autopilot] State dir:   .cadence/runs/01J9X7TBQK7M2W6E4HZGV4K3PB/
[autopilot] Step 3: implement (phase.start)
... work ...
[autopilot] Step 3: implement (phase.complete) → commit abc123 on feature/foo
```
These lines come FROM the dispatcher's events, not from the skill writing them. The skill only describes the lifecycle for human readers.

The skill's "Error Recovery" section is replaced with:
```
If a run halts mid-flight:
  $ cadence runs list                  # find the ulid
  $ cadence autopilot resume <ulid>    # resume at last completed phase
The engine refuses to resume if the worktree, git, or migration state
diverges from the recorded phase-output evidence (commit SHAs, migration
checksums, PR head ref, etc.). In that case the run is marked
needs-human and the operator fixes manually:
  $ cadence runs show <ulid>           # see what evidence diverged
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

`.cadence/runs/<ulid>/state.json` (typed payload per phase; expanded to address codex CRITICAL on durable phase-specific artifacts):

```json
{
  "schemaVersion": "1.0.0",
  "cadenceVersion": "8.5.0",
  "runId": "01J9X7TBQK7M2W6E4HZGV4K3PB",
  "status": "active",
  "argv": ["cadence","autopilot","docs/.../foo-design.md"],
  "createdByCommand": "autopilot",
  "featureFlags": { "CADENCE_RUN_STATE_ENABLED": true },
  "specPath": "docs/superpowers/specs/2026-05-27-foo-design.md",
  "repoRoot": "/Users/alex/work/cadence",
  "worktreePath": "/Users/alex/work/cadence/.cadence/worktrees/foo",
  "branch": "feature/foo",
  "baseSha": "abc1234567890",
  "profile": "solo",
  "profileSnapshot": { "codex_passes": {"low":1,"medium":2,"high":3}, "auto_merge": true },
  "currentPhase": "implement",
  "completedPhases": ["spec","plan","worktree"],
  "startedAt": "2026-05-27T08:14:22Z",
  "lastEventAt": "2026-05-27T08:31:09Z",
  "phaseOutputs": {
    "spec":     { "path": "docs/superpowers/specs/2026-05-27-foo-design.md", "sha": "...", "size": 1234 },
    "plan":     { "path": "docs/superpowers/plans/2026-05-27-foo.md", "sha": "...", "size": 2345 },
    "worktree": { "path": "/Users/.../worktrees/foo", "branch": "feature/foo", "createdAt": "..." },
    "implement":{ "baseSha": "abc123...", "headSha": "def456...", "commits": ["def456...","ghi789..."], "cleanAtComplete": true },
    "migrate":  { "appliedMigrations": [ { "id": "20260527_001", "checksum": "sha256:...", "appliedAt": "..." } ] },
    "validate": { "reportPath": ".claude/validation-report.json", "reportSha": "...", "verdict": "pass" },
    "pr":       { "number": 230, "url": "https://github.com/axledbetter/cadence/pull/230", "headRef": "feature/foo", "headShaAtCreate": "ghi789..." },
    "codex":    { "iterations": 1, "commentIds": ["pr_review_comment_id_..."] },
    "bugbot":   { "rounds": 2, "commentIds": ["c1","c2"], "fixed": ["c1"], "dismissed": ["c2"] },
    "merge":    { "mergedAt": "2026-05-27T09:12:00Z", "mergeCommit": "jkl012..." }
  }
}
```

State writes are **durable barriers** (per codex CRITICAL — overrides earlier "non-blocking" framing). When `CADENCE_RUN_STATE_ENABLED=true`:

- Every `phase.complete` issues an `fsync`-d write to `state.json` AND an O_APPEND atomic event append to `events.ndjson` BEFORE the next phase begins.
- If the write fails, the next phase does NOT execute — the run aborts with `needs-human` and the side effect just completed remains as-is (the dispatcher logs exactly what was completed but not recorded).
- This is the only way `decideReplay` can be trusted to make "skip-already-applied" decisions correctly.

`events.ndjson` is append-only; each line is `{ts, phase, kind: 'start'|'complete'|'failed', payload}`. Reuses existing v6 run-state engine primitives.

### 5. Phase-boundary contract (idempotent + verifiable)

Every phase must:
- Be idempotent at the boundary OR provably "already applied" via durable external evidence.
- Emit a typed `phase.complete` payload that captures enough evidence for `decideReplay` to be unambiguous on resume.

Per-phase verification protocol:

- **spec/plan**: file exists at recorded path AND content sha matches `phaseOutputs.spec.sha` → skip. Mismatch → `needs-human` (someone hand-edited).
- **worktree**: `git -C <repoRoot> worktree list --porcelain` includes recorded path AND branch matches → skip. Missing → `needs-human` (worktree removed externally).
- **implement**: `git -C <worktreePath> rev-parse HEAD` matches `phaseOutputs.implement.headSha` AND `git status --porcelain=v2` is clean → skip. HEAD diverges OR dirty index → `needs-human`. Note: agents may make additional commits during a phase; the recorded `commits[]` is the canonical list.
- **migrate**: each `appliedMigrations[i].id` must be present in the database's `cadence_migration_log` table (or equivalent) with matching checksum → skip. If marker missing OR checksum mismatch → `needs-human`. Non-transactional migrations with no checksum match → `needs-human` (never blind retry).
- **validate**: report file exists at recorded path AND sha matches AND verdict was `pass` → skip. Otherwise re-run (validate is idempotent).
- **PR**: `gh pr view <number> --json mergeable,headRefName` returns matching `headRef` → skip create. PR missing → re-create.
- **codex**: each recorded `commentIds[i]` exists on PR → skip that iteration. (Codex itself is idempotent at the comment-id level.)
- **bugbot**: same shape — recorded round outcomes determine whether to start another round.
- **merge**: `gh pr view <number> --json mergedAt` non-null → run complete.

If ANY phase cannot prove "fully applied with matching evidence," `decideReplay` returns `needs-human` rather than retry or skip. Never blind retry for phases with external side effects.

## Error handling

- **Lock held**: another `cadence autopilot` is running for this run → bail with PID, hostname, last heartbeat.
- **Stale lock**: PID no longer exists OR heartbeat older than `STALE_LOCK_TIMEOUT_SEC` (default 600s) → log diagnostic info and offer `cadence runs unlock <ulid> --force` path. Heartbeat is refreshed on every event append.
- **State schema mismatch**: `state.cadenceVersion` is a different MAJOR than current → bail with "run was started on vX, current is vY — manual fix required." MINOR/PATCH diffs are permitted with warning.
- **Run-state disabled**: resume attempted on a run whose `state.featureFlags.CADENCE_RUN_STATE_ENABLED` was false → bail with "this run was not checkpointed; cannot resume."
- **`decideReplay` returns `needs-human`**: print state + last 10 events + the specific divergence (e.g. "implement.headSha was def456, current is xyz999") and bail.
- **Worktree missing**: bail with "worktree at <path> not found; the run cannot resume — run was created with `git worktree add` and the worktree appears to have been removed."
- **Profile changed**: load profileSnapshot from state.json and use it; warn if current profile differs (print diff).
- **Side effect persisted but state.json write failed**: this is the most dangerous failure mode. Detected on next start when events.ndjson has a `phase.complete` event but state.json lacks the corresponding `phaseOutputs[phase]` field. → mark run `needs-human`, print which phase was orphaned. Operator must inspect external state (git, db, GH) to decide.

## Testing

**Unit** — `tests/autopilot/run-lifecycle.test.ts`:

1. Create new run → state.json + lock exist, currentPhase is `spec`, `status: active`, `cadenceVersion` set.
2. End-to-end happy path: 9 phase-complete events, lock released, final `status: complete`, all `phaseOutputs` populated.
3. Mid-flight SIGKILL after `implement` start → resume → `decideReplay` → retry (no completed event recorded).
4. Resume after `implement` complete → `decideReplay` → skip-already-applied, advances to `migrate`.
5. Worktree HEAD divergence: hand-commit in worktree post-crash, resume → preflight detects `headSha` mismatch → needs-human.
6. Dirty worktree at resume: `git status --porcelain=v2` non-empty → needs-human.
7. Concurrent resume blocked by lock; lock holder PID printed.
8. Stale lock: PID gone, heartbeat > timeout → `--force-unlock` path works; refuse without flag.

**Fault injection** (per codex CRITICAL — torn writes are the highest-risk failure mode) — `tests/autopilot/fault-injection.test.ts`:

9. Fail state.json write AFTER side effect succeeds (e.g. PR created, fs error on state.json) → next run start detects orphaned phase via events.ndjson vs state.json mismatch → marks needs-human.
10. Fail events.ndjson append mid-line → next start truncates partial line, treats phase as not-complete, replay logic handles.
11. Corrupt state.json (invalid JSON) → bail with "state corrupted, see events.ndjson for last good state."
12. Migration applied but state.json update interrupted → resume preflight reads migration_log, sees marker, marks `phaseOutputs.migrate` from db evidence, advances.
13. PR created but `phase.complete` not written → resume preflight queries `gh pr list --head <branch>`, finds PR, populates `phaseOutputs.pr` from gh evidence, advances.

**Schema** — `tests/autopilot/state-schema.test.ts`:

14. All required fields present on fresh state.
15. Round-trip JSON (write → read → re-write produces identical bytes).
16. Major version mismatch refuses resume.

**Integration** — `tests/autopilot/end-to-end-resume.test.ts`:

17. Runs a no-op fake-spec through full pipeline, kills after each phase, resumes, asserts final state matches a non-interrupted run.

## Backward compatibility

- Existing autopilot runs (no run-state) still work — when `CADENCE_RUN_STATE_ENABLED=false`, the dispatcher skips lifecycle calls entirely.
- When enabled, state writes are **durable barriers** (not "non-blocking" — that framing was wrong; see codex CRITICAL).
- `cadence autopilot` without explicit run-id auto-generates one. Resume requires the run-id.
- Resume of a run whose `featureFlags.CADENCE_RUN_STATE_ENABLED` was `false` is refused (state may be incomplete).
- No changes to spec/plan file format or location.

## Rollout

1. Land run-lifecycle.ts + tests behind `CADENCE_RUN_STATE_ENABLED` (default OFF in v8.5.0-pre).
2. Dogfood internally for a week — every cadence release through its own pipeline runs with the flag ON via local env.
3. Flip default to ON in v8.5.0.
4. Update README "Recovery" section.

## Out of scope (immediate)

- Distributed runs (multi-machine).
- Tarball-based run export (for sharing failed runs with maintainers).
- UI dashboard for active runs.
- Sub-phase / per-task checkpointing inside subagent execution.

## Post-launch follow-ups (codex WARNINGs/NOTEs to revisit)

- **Migration verification protocol formalization** — define `cadence_migration_log` table schema, checksum algorithm, applied-marker contract. The spec specifies semantics; the actual SQL belongs in a follow-up PR.
- **Stale lock tuning** — `STALE_LOCK_TIMEOUT_SEC` default 600s may be too long for fast iteration loops; consider profile-driven override.
- **Artifact path normalization** — store both repoRoot and normalized relative paths for repo artifacts; validate paths remain inside expected dirs before read/write. Spec implies; formalize the validator helper in follow-up.
- **PR/comment ID idempotency at codex/bugbot level** — depends on `scripts/codex-pr-review.ts` and `scripts/bugbot.ts` emitting stable IDs; audit those scripts and add ID emission if missing.
- **Mixed-mode safety** — if user toggles the flag between runs, ensure no silent partial state is created for legacy runs (covered by "resume refused if not checkpointed" rule, but worth a test).
