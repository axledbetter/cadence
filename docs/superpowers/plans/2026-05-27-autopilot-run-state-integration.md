---
title: Wire v6 Run-State Engine Into Autopilot Skill — Implementation Plan
date: 2026-05-27
spec: docs/superpowers/specs/2026-05-27-autopilot-run-state-integration-design.md
issue: 180
risk_tier: high
---

# Implementation Plan

## Scope reminder (revised per codex CRITICAL #1)

This PR ships the **run-state lifecycle PRIMITIVES** for the skill flow —
the `AutopilotRun` class, typed phase-output schema, resume-verifier with
injectable probes, the `cadence autopilot resume <ulid>` CLI inspection
verb, and the skill doc update. **It does NOT wire the Claude Code skill
harness to actually call `beginPhase/endPhase` at each step.** That bridge
(a `cadence autopilot lifecycle begin|end <phase>` shell verb, MCP tool,
or harness hook) is a separate, follow-up PR — we are intentionally
landing the durable machinery first so the bridge design can be reviewed
on its own.

The existing 4-phase `runAutopilot()` orchestrator in `src/cli/autopilot.ts`
is **not** the surface this PR changes (it already uses v6 run-state). The
10-phase skill flow (`spec → plan → worktree → implement → migrate →
validate → pr → codex → bugbot → merge`) — driven today by Claude Code
subagents reading `skills/autopilot/SKILL.md` — is the surface this PR
prepares for. `brainstorm` is intentionally NOT checkpointed: per the spec
the only allowed pause is user spec approval, which happens BEFORE the
checkpointable pipeline begins.

The new code lives alongside the existing orchestrator under the
`CADENCE_RUN_STATE_ENABLED` feature flag (default OFF in this PR). The
follow-up PR that wires the skill harness will flip the default and add
real call sites.

### Revised acceptance criteria

This PR is "done" when:

1. `AutopilotRun.create() / resume() / beginPhase() / endPhase() /
   failPhase() / release()` work as specified, with tests.
2. `cadence autopilot resume <ulid>` is a working **inspection** verb that
   prints the resume decision and the next phase the skill harness would
   execute. It does NOT execute phases.
3. `cadence runs show <ulid>` correctly prints autopilot phaseOutputs
   (regression test).
4. Skill `Error Recovery` section matches spec verbatim.
5. Feature flag is honored; creation refuses when flag is OFF in the
   current env; resume of a run created with flag ON works even when the
   current env flag is OFF (so an operator can inspect a checkpointed
   run after toggling).
6. All 17 spec tests green, all existing tests stay green.

## File-by-file change list

### NEW — `src/core/autopilot/run-lifecycle.ts`

The `AutopilotRun` class — the only public surface for skill-driven phase
lifecycle. Wraps existing v6 primitives (no duplication):

```typescript
import { createRun, runDirFor } from '../run-state/runs.ts';
import { acquireRunLock, peekLockOwner, forceTakeover, isPidAlive } from '../run-state/lock.ts';
import { appendEvent, readEvents } from '../run-state/events.ts';
import { readStateSnapshot, writeStateSnapshot, recoverState } from '../run-state/state.ts';
import type {
  AutopilotPhaseOutputs, AutopilotRunConfig,
} from './run-state-schema.ts';

export type SkillPhaseName =
  | 'spec' | 'plan' | 'worktree' | 'implement'
  | 'migrate' | 'validate' | 'pr' | 'codex' | 'bugbot' | 'merge';

export const SKILL_PHASES: readonly SkillPhaseName[] = [
  'spec','plan','worktree','implement','migrate','validate','pr','codex','bugbot','merge',
] as const;

/** Per-phase typed input (free-form for now; outputs are the load-bearing
 *  contract). Each phase passes what it has at begin-time; this is purely
 *  informational and is not persisted as durable evidence. */
export type PhaseInput<P extends SkillPhaseName> = Record<string, unknown>;
/** Per-phase typed output — the persisted durable evidence. Defined in
 *  run-state-schema.ts as `AutopilotPhaseOutputs[P]`. NonNullable because
 *  we don't accept partial/empty outputs at endPhase time. */
export type PhaseOutput<P extends SkillPhaseName> =
  NonNullable<AutopilotPhaseOutputs[P]>;

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
  /** Test seam — inject a WriterId so unit tests can simulate
   *  cross-process owners without forking. Production callers omit. */
  __writerIdOverride?: { pid: number; hostHash: string };
  /** Test seam — override Date.now() for deterministic heartbeat tests. */
  __clock?: () => number;
}

export interface ResumeOpts {
  cwd: string;
  runId: string;
  __writerIdOverride?: { pid: number; hostHash: string };
  __clock?: () => number;
}

/** Returned by AutopilotRun.resume(). The verifier's decision is exposed
 *  so the CLI shim AND the future skill harness can both consume it. */
export type ResumeResult =
  | { kind: 'resumable'; run: AutopilotRun; nextPhase: SkillPhaseName; decision: 'proceed-fresh' | 'skip-already-applied' | 'retry' }
  | { kind: 'needs-human'; runDir: string; runId: string; reason: string; evidence: Record<string, unknown> }
  | { kind: 'refused'; reason: 'flag-was-off' | 'schema-major-mismatch' | 'lock-held' | 'not-found' | 'corrupted'; details: Record<string, unknown> };

export class AutopilotRun {
  // Static factories. create() requires env flag ON; resume() does not (so
  // operators can inspect a checkpointed run after toggling).
  static create(opts: AutopilotCreateOpts): Promise<AutopilotRun>;
  static resume(opts: ResumeOpts): Promise<ResumeResult>;

  // Lifecycle — generic narrows on the literal phase passed in.
  beginPhase<P extends SkillPhaseName>(phase: P, input: PhaseInput<P>): Promise<void>;
  endPhase<P extends SkillPhaseName>(phase: P, output: PhaseOutput<P>): Promise<void>;
  failPhase(phase: SkillPhaseName, err: Error, hint: 'retry'|'needs-human'): Promise<void>;

  // Accessors
  get currentPhase(): SkillPhaseName;
  get runId(): string;
  get runDir(): string;
  release(): Promise<void>;

  /** Best-effort heartbeat refresh. Called every PHASE_HEARTBEAT_INTERVAL_MS
   *  by a setInterval the lifecycle owns while in a phase, AND once at
   *  begin/end of every phase. Updates `lastHeartbeatAt` in the lock meta;
   *  acquiredAt stays immutable. */
  private heartbeat(): void;
}
```

**Implementation notes:**

- `create()` delegates to `runs.ts:createRun({ phases: SKILL_PHASES, config })`.
  The `config` object stores the spec's expanded state schema fields
  (`cadenceVersion`, `argv`, `createdByCommand: 'autopilot'`, `featureFlags`,
  `profileSnapshot`, `specPath`, `repoRoot`, `worktreePath?`, `branch?`,
  `baseSha?`, empty `phaseOutputs: {}`) so they ride inside `state.config`
  (the v6 `RunState.config` field is `Record<string, unknown>` — free-form,
  exactly what we need). Adding **typed accessors** on `AutopilotRun`
  keeps callers from depending on the inner shape.
- `create()` REFUSES if the current env's `CADENCE_RUN_STATE_ENABLED !==
  'true'`. Tests inject the env value via the standard `process.env`
  pattern. There is no opt-out for create.

- `resume()` reads `state.json` via `readStateSnapshot()`, falls back to
  `recoverState()` if missing/corrupt, then:
  1. Refuses with `{ kind: 'refused', reason: 'not-found' }` if the run
     dir doesn't exist.
  2. Refuses with `{ kind: 'refused', reason: 'corrupted' }` if both
     snapshot and events-replay fail.
  3. Refuses with `{ kind: 'refused', reason: 'schema-major-mismatch' }`
     if `state.config.cadenceVersion` MAJOR mismatches the binary's MAJOR
     (codex CRITICAL: schema mismatch). MINOR/PATCH diffs allowed.
  4. Refuses with `{ kind: 'refused', reason: 'flag-was-off' }` if
     `state.config.featureFlags.CADENCE_RUN_STATE_ENABLED !== true`
     (state was created without checkpointing — cannot resume).
  5. Acquires lock via `acquireRunLock()`. If `peekLockOwner()` shows a
     dead PID + heartbeat older than `STALE_LOCK_TIMEOUT_SEC=600`,
     returns `{ kind: 'refused', reason: 'lock-held' }` with
     `runs cleanup --force-unlock` hint embedded in `details`. Stale
     detection uses a NEW explicit `lastHeartbeatAt` field (NOT
     `acquiredAt` which stays immutable — codex WARNING #5). The lock
     meta sidecar is extended with `lastHeartbeatAt` via the same
     `writeMeta` path that v6 uses today.
  6. Runs `verifyPhaseEvidence()` for every phase in `completedPhases`
     against the persisted `phaseOutputs[phase]` + injected probes. ANY
     `kind: 'needs-human'` collapses the whole resume to `{ kind:
     'needs-human', ... }` with the offending phase's evidence.
  7. Computes `nextPhase` as the first phase in `SKILL_PHASES` after the
     last successfully verified one. Returns `{ kind: 'resumable', run,
     nextPhase, decision }` where `decision` distinguishes a fresh next
     phase from a needs-rerun retry.
  8. Detects **orphaned phase.success events** (fault injection 9):
     events log shows `phase.success` for phase X but
     `state.config.phaseOutputs[X]` is missing AND the success event's
     `meta.output` (codex WARNING #4 — see below) is also missing →
     `{ kind: 'needs-human', reason: 'orphaned phase success' }`.

- `beginPhase(phase, input)` → `appendEvent({ event: 'phase.start', phase,
  phaseIdx, idempotent: <per-phase>, hasSideEffects: <per-phase>, attempt:
  <count+1> })`. The `<per-phase>` map lives in `run-state-schema.ts` so
  the source of truth is one place. Also kicks off the heartbeat interval
  (every 60s during a phase).

- `endPhase(phase, output)` is the **durability barrier**:
  1. Validate output via `validatePhaseOutput(phase, output)`; throw
     `GuardrailError('invalid_phase_output')` on validation failure.
  2. Compute `output.sha` (sha256 of canonical JSON) where the schema
     calls for it.
  3. `appendEvent({ event: 'phase.success', ..., artifacts: <derived>,
     ... })` — fsync'd by the existing `appendEventInner` path.
     **Codex WARNING #4 fix:** the v6 `PhaseSuccessEvent` schema doesn't
     have a freeform meta slot, so we encode the validated output as one
     of the `artifacts[]` entries with `name = '__autopilot_output__'`
     and a small JSON payload written to
     `<runDir>/artifacts/<phase>.json` (sha256'd, sized). On resume, if
     `state.config.phaseOutputs[phase]` is missing we read
     `artifacts/<phase>.json` and re-populate. This makes the event log
     the SOLE durable source of truth — `state.json` is a derived cache.
  4. Refresh `state.json`: merge `output` into
     `state.config.phaseOutputs[phase]`, mark phase succeeded in
     `state.phases[phaseIdx]`, advance `currentPhaseIdx`. Call
     `writeStateSnapshot()` (atomic + fsync + dir-fsync).
  5. If step 3 succeeds but step 4 fails: the event log has enough info
     (see step 3) to recover. We still propagate a typed
     `GuardrailError('durability_barrier_failed')` so the caller aborts
     the run cleanly; resume() will reconstruct from artifacts/.
  6. Heartbeat fired before AND after this whole block.

- `failPhase(phase, err, hint)` → emit `phase.failed` (or
  `phase.needs-human` when `hint==='needs-human'`) then refresh state.
  Stops the heartbeat interval.

- `release()` → idempotent lock release. Stops heartbeat interval.

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
| codex | false | true | [] | ['github-comment'] | `{ iterations, commentIds[] }` |
| bugbot | false | true | [] | ['github-comment'] | `{ rounds, commentIds[], fixed[], dismissed[] }` |
| merge | false | true | ['github-pr'] | [] | `{ mergedAt, mergeCommit }` |

**Codex NOTE #9 fix:** `codex` and `bugbot` are NOT idempotent — re-running
either creates new GitHub comments. On resume, `verifyPhaseEvidence()`
queries each recorded `commentIds[i]` via `ghPrComment()`; if ALL exist,
skip the phase; if ANY are missing, surface `needs-human` (operator
inspects + decides whether to re-run or hand-merge the existing comment
set). We never auto-rerun these phases.

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
field presence + types + **lightweight semantic format** (codex NOTE #10):

- `sha` / `baseSha` / `headSha` / `mergeCommit` — full 40-char hex (no
  short SHAs; tests use canonical full SHAs)
- `reportSha` — sha256 prefix `sha256:` + 64-char hex
- `commits[]` — non-empty array of full-hex commit SHAs
- `url` — must parse via WHATWG URL
- ISO timestamps — must parse via `Date.parse`
- `path` / `reportPath` — must be non-empty; paths inside the repo are
  stored relative to `repoRoot` (the verifier resolves them; the
  validator just checks non-empty)
- `commentIds[]` — non-empty arrays where the contract requires them

Deep platform checks (e.g. `appliedMigrations[].id` is in the migration
log; the commit exists in git) happen in `resume-verifier.ts`, not here.

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

**Codex CRITICAL #2 fix — migration safety:** until the
`cadence_migration_log` table schema lands (separate PR per spec
post-launch follow-up), `migrationLogContains()` returns `{ found: false
}` for ALL ids. Combined with the verifier rule "any unverified
post-effect ref ⇒ needs-human", this means **a completed `migrate` phase
on resume ALWAYS routes to `needs-human`** until the migration log
exists. We never auto-skip and never auto-rerun a migration on resume.
The verifier emits a specific `reason: 'migration verification not yet
available — set CADENCE_MIGRATION_LOG_TABLE and try again, or
--force-replay after manual inspection'`. This is enforced by a unit
test in `resume-verifier.test.ts`.

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

Thin shim: instantiates `AutopilotRun.resume()`, prints the `ResumeResult`
(decision + nextPhase OR refusal reason + remediation hints), exits with:

- `0` — `{ kind: 'resumable' }` (next phase identified; skill harness can
  pick up)
- `1` — `{ kind: 'needs-human' }` (verifier detected divergence)
- `2` — `{ kind: 'refused', reason: 'lock-held' }` (stale-lock recovery
  available via `runs cleanup --force-unlock`)
- `1` — any other refusal

Uses `try { ... } finally { await result.run?.release() }` so locks are
always released on inspection (codex WARNING #5). Does NOT itself drive
phase execution — the skill's host process does that after acquiring the
run handle in a follow-up PR.

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

**No changes in this PR.** The existing 4-phase orchestrator is untouched.
The skill-harness bridge to `AutopilotRun` lands in a follow-up PR
(scope-revised per codex CRITICAL #1).

### NEW TESTS

All under `tests/autopilot/`:

- `tests/autopilot/run-lifecycle.test.ts` — 8 unit tests (spec items 1–8)
- `tests/autopilot/fault-injection.test.ts` — 5 tests (spec items 9–13)
- `tests/autopilot/state-schema.test.ts` — 3 tests (spec items 14–16)
- `tests/autopilot/end-to-end-resume.test.ts` — 1 integration test (item 17)
- `tests/autopilot/resume-verifier.test.ts` — small additional file
  covering: the migration-safety guard (completed migrate phase routes
  to needs-human until log table exists), codex/bugbot commentId
  verification, and probe injection. These are derivable from the 17
  numbered tests but factoring them into their own file keeps the
  run-lifecycle tests focused on the lifecycle class.

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
