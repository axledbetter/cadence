---
title: Wire v6 Run-State Engine Into Autopilot Skill — Implementation Plan
date: 2026-05-27
spec: docs/superpowers/specs/2026-05-27-autopilot-run-state-integration-design.md
issue: 180
risk_tier: high
---

# Implementation Plan

## Scope reminder

This plan ships the **skill-level** autopilot checkpoint/resume. The existing
`runAutopilot()` orchestrator in `src/cli/autopilot.ts` already drives a
4-phase v6 run (scan → spec → plan → implement). It is **not** the surface
this PR changes. The surface this PR changes is the 9-step skill flow
(brainstorm → spec → plan → implement → migrate → validate → PR → codex →
bugbot → merge), which today is driven by Claude Code subagents reading
`skills/autopilot/SKILL.md` and is completely blind to v6 run-state.

We are adding a new dispatcher path — a thin lifecycle wrapper plus a CLI
entry point — that the skill's host process (the cadence binary, invoked by
Claude Code) can call at each phase boundary. The existing 4-phase
orchestrator continues to work unchanged; the new code lives alongside it
under the `CADENCE_RUN_STATE_ENABLED` feature flag (default OFF in this PR).

## File-by-file change list

### NEW — `src/core/autopilot/run-lifecycle.ts`

The `AutopilotRun` class — the only public surface for skill-driven phase
lifecycle. Wraps existing v6 primitives (no duplication):

```typescript
import { createRun, runDirFor } from '../run-state/runs.ts';
import { acquireRunLock, peekLockOwner, forceTakeover, isPidAlive } from '../run-state/lock.ts';
import { appendEvent, readEvents } from '../run-state/events.ts';
import { readStateSnapshot, writeStateSnapshot, recoverState } from '../run-state/state.ts';

export type SkillPhaseName =
  | 'spec' | 'plan' | 'worktree' | 'implement'
  | 'migrate' | 'validate' | 'pr' | 'codex' | 'bugbot' | 'merge';

export const SKILL_PHASES: readonly SkillPhaseName[] = [
  'spec','plan','worktree','implement','migrate','validate','pr','codex','bugbot','merge',
] as const;

export interface AutopilotCreateOpts {
  cwd: string;
  specPath: string;
  cadenceVersion: string;
  argv: readonly string[];
  featureFlags: Record<string, boolean>;
  profile: string;
  profileSnapshot: Record<string, unknown>;
  worktreePath?: string;
  branch?: string;
  baseSha?: string;
}

export class AutopilotRun {
  // Static factories
  static create(opts: AutopilotCreateOpts): Promise<AutopilotRun>;
  static resume(opts: { cwd: string; runId: string }): Promise<AutopilotRun>;

  // Lifecycle
  beginPhase(phase: SkillPhaseName, input: PhaseInput<typeof phase>): Promise<void>;
  endPhase(phase: SkillPhaseName, output: PhaseOutput<typeof phase>): Promise<void>;
  failPhase(phase: SkillPhaseName, err: Error, hint: 'retry'|'needs-human'): Promise<void>;

  // Accessors
  get currentPhase(): SkillPhaseName;
  get runId(): string;
  get runDir(): string;
  release(): Promise<void>;
}
```

**Implementation notes:**

- `create()` delegates to `runs.ts:createRun({ phases: SKILL_PHASES, config })`.
  The `config` object stores the spec's expanded state schema fields
  (`cadenceVersion`, `argv`, `createdByCommand: 'autopilot'`, `featureFlags`,
  `profileSnapshot`, `specPath`, `repoRoot`, `worktreePath?`, `branch?`,
  `baseSha?`) so they ride inside `state.config` (the v6 `RunState.config`
  field is `Record<string, unknown>` — free-form, exactly what we need).
  Adding **typed accessors** on `AutopilotRun` keeps callers from depending
  on the inner shape.

- `resume()` reads `state.json` via `readStateSnapshot()`, falls back to
  `recoverState()` if missing/corrupt, then:
  1. Refuses if `state.config.cadenceVersion` MAJOR mismatches the current
     binary's major (codex CRITICAL: state-schema mismatch).
  2. Refuses if `state.config.featureFlags.CADENCE_RUN_STATE_ENABLED !==
     true` (per spec: cannot resume a run not checkpointed).
  3. Acquires lock via `acquireRunLock()`. If `peekLockOwner()` shows a
     dead PID + heartbeat older than `STALE_LOCK_TIMEOUT_SEC=600`, surface
     a `runs cleanup --force-unlock` hint. We piggyback on the existing
     `lock.lock-meta.json.acquiredAt` field as the heartbeat (refreshed on
     each `endPhase` write because we update the meta sidecar).
  4. Returns an `AutopilotRun` whose `currentPhase` is computed from the
     events log by scanning the most recent `phase.start` not followed by
     a matching `phase.success` or `phase.failed`.

- `beginPhase(phase, input)` → `appendEvent({ event: 'phase.start', phase,
  phaseIdx, idempotent: <per-phase>, hasSideEffects: <per-phase>, attempt:
  <count+1> })`. The `<per-phase>` map lives in this file (see "Per-phase
  contract table" below) so the source of truth is one place.

- `endPhase(phase, output)` is the **durability barrier**:
  1. Serialize `output` and validate it satisfies the typed
     `PhaseOutputs[phase]` schema (see schema section).
  2. Compute `output.sha` (sha256 of canonical JSON) where the schema
     calls for it.
  3. `appendEvent({ event: 'phase.success', ..., artifacts: <derived> })`
     — this is fsync'd by the existing `appendEventInner` path.
  4. Refresh `state.json`: merge `output` into
     `state.config.phaseOutputs[phase]`, mark phase succeeded in
     `state.phases[phaseIdx]`, advance `currentPhaseIdx`. Call
     `writeStateSnapshot()` (atomic + fsync + dir-fsync).
  5. If EITHER step 3 or 4 throws, propagate to caller. The caller is the
     skill harness; per spec it MUST abort the run rather than start the
     next phase. We surface a typed `GuardrailError(code:
     'durability_barrier_failed')` so the dispatcher can distinguish this
     case from a normal phase failure.

- `failPhase(phase, err, hint)` → emit `phase.failed` (or
  `phase.needs-human` when `hint==='needs-human'`) then refresh state.

- `release()` → idempotent lock release.

**Per-phase contract table** (one place, used by `beginPhase` and by
`resumePreflight()` verification on resume):

| Phase | idempotent | hasSideEffects | preEffectRefKinds | postEffectRefKinds | typed output |
|---|---|---|---|---|---|
| spec | true | false | [] | [] | `{ path, sha, size }` |
| plan | true | false | [] | [] | `{ path, sha, size }` |
| worktree | false | true | [] | [] | `{ path, branch, createdAt }` |
| implement | false | true | [] | [] | `{ baseSha, headSha, commits[], cleanAtComplete }` |
| migrate | false | true | ['migration-batch'] | ['migration-version'] | `{ appliedMigrations: [{id, checksum, appliedAt}] }` |
| validate | true | false | [] | [] | `{ reportPath, reportSha, verdict }` |
| pr | false | true | ['github-pr'] | [] | `{ number, url, headRef, headShaAtCreate }` |
| codex | true | true | [] | ['github-comment'] | `{ iterations, commentIds[] }` |
| bugbot | true | true | [] | ['github-comment'] | `{ rounds, commentIds[], fixed[], dismissed[] }` |
| merge | false | true | ['github-pr'] | [] | `{ mergedAt, mergeCommit }` |

The contract table reuses v6's `ExternalRefKind` union — no new ref kinds
required.

### NEW — `src/core/autopilot/run-state-schema.ts`

Pure types + JSON-schema-style validators for the typed `phaseOutputs`
payloads. **Zero IO; pure functions only.** Imported by `run-lifecycle.ts`
and by the tests.

```typescript
export interface SpecPhaseOutput { path: string; sha: string; size: number; }
export interface PlanPhaseOutput { path: string; sha: string; size: number; }
export interface WorktreePhaseOutput { path: string; branch: string; createdAt: string; }
export interface ImplementPhaseOutput {
  baseSha: string; headSha: string; commits: string[]; cleanAtComplete: boolean;
}
export interface MigratePhaseOutput {
  appliedMigrations: { id: string; checksum: string; appliedAt: string }[];
}
export interface ValidatePhaseOutput {
  reportPath: string; reportSha: string; verdict: 'pass' | 'fail';
}
export interface PrPhaseOutput {
  number: number; url: string; headRef: string; headShaAtCreate: string;
}
export interface CodexPhaseOutput { iterations: number; commentIds: string[]; }
export interface BugbotPhaseOutput {
  rounds: number; commentIds: string[]; fixed: string[]; dismissed: string[];
}
export interface MergePhaseOutput { mergedAt: string; mergeCommit: string; }

export interface AutopilotPhaseOutputs {
  spec?: SpecPhaseOutput;
  plan?: PlanPhaseOutput;
  worktree?: WorktreePhaseOutput;
  implement?: ImplementPhaseOutput;
  migrate?: MigratePhaseOutput;
  validate?: ValidatePhaseOutput;
  pr?: PrPhaseOutput;
  codex?: CodexPhaseOutput;
  bugbot?: BugbotPhaseOutput;
  merge?: MergePhaseOutput;
}

/** Extra fields stored under state.config for autopilot runs. The v6
 *  RunState.config is free-form Record<string, unknown>; this interface
 *  pins the shape autopilot writes. */
export interface AutopilotRunConfig {
  cadenceVersion: string;
  argv: readonly string[];
  createdByCommand: 'autopilot';
  featureFlags: Record<string, boolean>;
  specPath: string;
  repoRoot: string;
  worktreePath?: string;
  branch?: string;
  baseSha?: string;
  profile: string;
  profileSnapshot: Record<string, unknown>;
  phaseOutputs: AutopilotPhaseOutputs;
}

export function validatePhaseOutput<P extends keyof AutopilotPhaseOutputs>(
  phase: P, output: unknown,
): { ok: true; value: NonNullable<AutopilotPhaseOutputs[P]> } | { ok: false; error: string };

export function validateAutopilotRunConfig(
  cfg: unknown,
): { ok: true; value: AutopilotRunConfig } | { ok: false; error: string };

/** Major-version compatibility check (codex CRITICAL: schema mismatch). */
export function isMajorCompatible(stateVersion: string, binaryVersion: string): boolean;
```

Validators are hand-rolled (no ajv dependency — repo already has it but
keeping this layer dependency-free makes tests trivial). They check
field presence + types only; semantic checks (e.g. `appliedMigrations[].id`
exists in the migration log) happen in the resume preflight, not here.

### NEW — `src/core/autopilot/resume-verifier.ts`

Per-phase external-evidence verification. Called by `AutopilotRun.resume()`
to compute the resume decision against on-disk and platform state. Pure
functions taking `phaseOutputs[phase]` + a small set of injectable probes
(filesystem, git, gh, supabase) so tests can stub them.

```typescript
export type PhaseVerificationResult =
  | { kind: 'verified-applied'; phase: SkillPhaseName }
  | { kind: 'must-rerun'; phase: SkillPhaseName; reason: string }
  | { kind: 'needs-human'; phase: SkillPhaseName; reason: string; evidence: unknown };

export interface VerifierProbes {
  fileExists(path: string): boolean;
  fileSha(path: string): string;
  gitWorktreeList(repoRoot: string): { path: string; branch: string }[];
  gitRevParseHead(worktreePath: string): string;
  gitStatusPorcelain(worktreePath: string): string;
  migrationLogContains(id: string): Promise<{ found: boolean; checksum?: string }>;
  ghPrView(num: number): Promise<{ headRefName: string; mergedAt: string|null } | null>;
  ghPrComment(commentId: string): Promise<{ exists: boolean }>;
}

export async function verifyPhaseEvidence(
  phase: SkillPhaseName,
  output: unknown,
  probes: VerifierProbes,
): Promise<PhaseVerificationResult>;
```

Probe implementations live in `src/core/autopilot/probes.ts` (real fs / git
/ gh shellouts) and are passed in. Tests inject stubs.

### NEW — `src/core/autopilot/probes.ts`

Production probe implementations. Each is one small function. Uses the
existing `shell.ts` helper for git/gh calls. Migration-log probe is a
TODO/stub returning `{ found: false }` for now — per spec post-launch
follow-up, the `cadence_migration_log` table schema is a separate PR.

### MODIFIED — `src/cli/index.ts`

Add the `cadence autopilot resume <ulid>` dispatch path. Two-line addition
to the existing `case 'autopilot'` block:

```typescript
// At the top of `case 'autopilot':` — peek at sub-verb.
const sub = args[subcommandIdx + 1];
if (sub === 'resume') {
  const ulid = args[subcommandIdx + 2];
  if (!ulid || ulid.startsWith('--')) {
    process.stderr.write('[autopilot] resume requires a run ID\n');
    process.exit(1);
  }
  const { runAutopilotResume } = await import('./autopilot-resume.ts');
  const result = await runAutopilotResume({ cwd: process.cwd(), runId: ulid });
  process.exit(result.exitCode);
}
// ... existing autopilot handling below ...
```

### NEW — `src/cli/autopilot-resume.ts`

Thin shim: instantiates `AutopilotRun.resume()`, prints status + decision,
exits with `0` if resume succeeded (and either advanced or marked
needs-human cleanly) or `1` on hard refusal. Does NOT itself drive phase
execution — the skill's host process does that after acquiring the run
handle. For now `runAutopilotResume` is a lookup-and-print path; once the
skill harness is wired to AutopilotRun (separate follow-up), this verb
will hand off the handle.

The verb is intentionally minimal because the spec is explicit: the skill
is the driver, not the CLI. The CLI only acquires/inspects.

### MODIFIED — `src/cli/runs.ts`

Two small changes:

1. **`runRunsShow`** — already exists. Verify it correctly prints the new
   `state.config.phaseOutputs` field (it just JSON-prints state.json, so
   this is automatic — covered by a regression test).
2. **`runRunsGc`** — already iterates `runs/` dirs. Verify that autopilot
   runs (which write `state.config.createdByCommand: 'autopilot'`) are
   GC-eligible under the existing terminal-status check (no code change,
   regression test only).

### MODIFIED — `skills/autopilot/SKILL.md`

**Error Recovery section only.** Per codex CRITICAL: the skill is
documentation/UX, NOT the source of truth for phase boundaries. Replace the
existing `## Error Recovery` block with the spec's verbatim block:

```markdown
## Error Recovery

If a run halts mid-flight:
  $ cadence runs list                  # find the ulid
  $ cadence autopilot resume <ulid>    # resume at last completed phase

The engine refuses to resume if the worktree, git, or migration state
diverges from the recorded phase-output evidence (commit SHAs, migration
checksums, PR head ref, etc.). In that case the run is marked
needs-human and the operator fixes manually:
  $ cadence runs show <ulid>           # see what evidence diverged

Per-run state lives at `.guardrail-cache/runs/<ulid>/`. Set
`CADENCE_RUN_STATE_ENABLED=true` to opt in (default off in v8.5.0).
```

No other skill changes. The skill describes UX. The dispatcher in
`run-lifecycle.ts` is the authoritative boundary.

### MODIFIED — `src/cli/autopilot.ts`

Add the feature-flag check + AutopilotRun bridge at the top of
`runAutopilot()`:

```typescript
const runStateEnabled = process.env.CADENCE_RUN_STATE_ENABLED === 'true';
// When enabled, the existing v6 orchestrator path is unchanged — we only
// emit one additional bridge event so a future skill-driven resume can
// distinguish skill runs from orchestrator-only runs. This is the
// minimum-viable change: the spec's full skill-bridge wiring lands in a
// follow-up because today's `runAutopilot` is invoked by the v6.2.x
// orchestrator path, NOT by the skill harness. The skill harness is the
// Claude Code subagent reading SKILL.md; its bridge call site is `cadence
// autopilot ...` invocations the agent issues, which already go through
// this function.
```

No behavioral change when flag is OFF.

### NEW TESTS

All under `tests/autopilot/`:

- `tests/autopilot/run-lifecycle.test.ts` — 8 unit tests (spec items 1–8)
- `tests/autopilot/fault-injection.test.ts` — 5 tests (spec items 9–13)
- `tests/autopilot/state-schema.test.ts` — 3 tests (spec items 14–16)
- `tests/autopilot/end-to-end-resume.test.ts` — 1 integration test (item 17)

**Test patterns reused from existing v6 tests**:
- `tests/run-state/lock.test.ts` for stale-lock semantics fixtures
- `tests/run-state/events.test.ts` for fault-injection scaffolding
- `tests/run-state/state.test.ts` for atomic-write tests

Each test creates a temp dir via `fs.mkdtempSync`, calls
`AutopilotRun.create()`, manipulates state, verifies behavior. Stale-lock
tests use the writerId override to simulate a dead PID:

```typescript
const run = await AutopilotRun.create({ ..., __writerIdOverride: { pid: 99999, hostHash: '...' } });
// force-takeover the meta sidecar with a dead pid, set acquiredAt to >600s ago
// new AutopilotRun.resume() should detect stale + offer cleanup hint
```

**End-to-end test (item 17)** runs a no-op fake-spec through all 10 phases
in sequence (each `beginPhase` → `endPhase` pair with synthetic output
matching the schema), kills the process between phases by emulating a
SIGKILL (just stops calling lifecycle methods), then resumes, verifies the
final state matches the never-interrupted control.

## Step ordering

1. Land state schema types + validators (`run-state-schema.ts`) — pure
   code, easy to land first.
2. Land `resume-verifier.ts` + `probes.ts` — depends on schema.
3. Land `run-lifecycle.ts` — depends on both above. This is the largest
   single file (~400 LOC); split into a `class AutopilotRun` + free
   functions for the lifecycle steps.
4. Land tests against the lifecycle. Fix issues iteratively.
5. Wire `src/cli/autopilot-resume.ts` + the dispatcher hook in
   `src/cli/index.ts`. Tests for the CLI shim (smoke test via spawning
   the bin in a temp dir).
6. Update `skills/autopilot/SKILL.md` Error Recovery block.
7. Re-run `npm run build && npm test`. Iterate until green.

## Risks & mitigations

- **Risk:** the existing 4-phase v6 orchestrator and the new 10-phase
  skill lifecycle could create two state.json shapes in the same
  `.guardrail-cache/runs/` tree.
  **Mitigation:** they SHARE the same `RunState` shape; the differences
  are inside `state.config` (free-form). `runs list/show/gc` work for
  both. The phase count differs but `runs show` already prints it
  generically.

- **Risk:** schema-version checks could falsely refuse legitimate resumes
  across minor version bumps.
  **Mitigation:** only MAJOR mismatch refuses; minor/patch warns. Tested
  in `state-schema.test.ts` item 16.

- **Risk:** durability-barrier failure during `endPhase` leaves orphaned
  side effects.
  **Mitigation:** per spec, we mark `needs-human` rather than retrying.
  Detected on next start via events.ndjson vs state.json mismatch (fault
  injection test 9). The dispatcher checks for orphaned `phase.success`
  events with no matching `phaseOutputs[phase]` field at `resume()` time.

- **Risk:** the feature flag default of OFF means this PR ships
  unexercised in dogfooding by default.
  **Mitigation:** rollout plan (spec section "Rollout") flips to ON in
  v8.5.0 via env. The flag is per-invocation (env var), not config —
  cheap to flip per run during dogfood.

## Out of scope for this PR

- Wiring the skill harness (Claude Code subagent) to actually call
  `AutopilotRun.beginPhase/endPhase` for each step. Today the skill runs
  via Claude Code reading SKILL.md — making it shell out to a new
  `cadence autopilot lifecycle <phase> --begin/--end` verb is a UX
  decision better made separately. **What this PR provides** is the
  durable machinery; the skill harness wiring lands when we decide
  whether the bridge is a shell verb, an MCP tool, or a config flag in
  `guardrail.config.yaml`.
- `cadence_migration_log` table schema (spec post-launch follow-up).
- `STALE_LOCK_TIMEOUT_SEC` profile override (spec post-launch follow-up).
- Forensic export tarball.

## Acceptance criteria

- All 17 spec tests pass.
- `npm run build` clean.
- `npm test` clean (existing tests untouched).
- `skills/autopilot/SKILL.md` Error Recovery section matches spec verbatim.
- Feature flag default OFF; flipping `CADENCE_RUN_STATE_ENABLED=true`
  enables the AutopilotRun bridge path without breaking the existing
  orchestrator.
- Codex pass on the PR completes with no CRITICAL findings outstanding.
