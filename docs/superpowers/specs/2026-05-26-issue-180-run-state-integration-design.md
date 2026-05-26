---
title: v6 Run-State Engine Integration into the Autopilot Skill (checkpoint/resume)
risk: high
status: RFC — spec for review, no implementation yet
issue: https://github.com/axledbetter/cadence/issues/180
base_sha: 34e0bd8
codex_passes_completed: 5
---

# v6 Run-State Engine Integration into the Autopilot Skill (RFC #180)

## TL;DR

`src/core/run-state/` (4,873 LOC) ships durable checkpoint/resume infrastructure:
`createRun`, `runPhase`, `decideReplay`, `resumePreflight`, `listRuns`,
`gcRuns`, `runRunResume`, `repo-lock`, `sameness-detector`, `provider-readback`.

The CLI verb `cadence autopilot` (`src/cli/autopilot.ts`) already drives the
six built-in pipeline phases (`scan → spec → plan → implement → migrate → pr`)
through this engine under one `runId`. **It is already partially integrated.**

What is **NOT** integrated is **the `skills/autopilot/SKILL.md` flow** — the
LLM-driven nine-step pipeline (brainstorm → spec → plan → impl → validate →
migrate → PR → codex-review → bugbot) that runs inside the Claude Code
agent. The skill is the surface real users invoke. It has no concept of a
`runId`, no checkpoint, no resume verb. A Mac sleep at Step 6 leaves a dirty
worktree, an unknown number of commits, and no path back.

There are also two related gaps:

1. **No top-level `cadence autopilot resume <ulid>` verb.** `runs resume`
   exists but is documented as **lookup-only** through Phase 6+. The actual
   re-entry point that re-attaches a new process to an existing runId,
   re-acquires the lock, and continues from the next phase is unimplemented.
2. **Concurrent-dispatch (v7.11.0) shares the run-state writer for `task.*`
   events but has no resume contract.** A scheduler crash mid-fan-out leaves
   partial `task.started`/`task.completed` records with no resume protocol.

This spec lays out the integration architecture in three phases (A, B, C). It
recommends shipping **Phase A only as the first PR (this RFC)** and gating
Phases B/C on separate plans + reviews. Phase A is a spec PR — no engine code
changes. Phases B/C are implementation PRs.

## Why this matters

A 30–90 minute autopilot run that dies mid-flight (Mac sleep, network drop,
Anthropic API throttle, Cursor process kill, OOM) leaves the user with:

- A dirty worktree they don't know is safe to merge or discard.
- An impl agent's commits that may or may not have landed.
- A spec they don't know if Codex reviewed.
- A PR that may or may not exist.
- No way to ask "what state is the run in" without grepping git history.

The v6 engine answers ALL of those questions by construction. It is sitting
unused at the skill level — the single surface real users invoke.

## Non-goals (deliberate)

- **Replacing the v6 engine code.** The engine ships as-is. Phase A is about
  wiring the skill to it; Phases B/C extend the CLI surface.
- **Distributed runs / multi-machine resume.** Single machine, single user.
- **Resuming PARTIAL phases.** Resume is phase-boundary granular. A
  crash mid-`runPhase` resumes by re-entering that phase (which `runPhase`
  itself gates via `decideReplay` + `resumePreflight`).
- **Persisting the LLM agent's in-memory conversation.** The skill execution
  is the Claude Code session; resuming that session is a Claude Code concern,
  not a Cadence concern. Cadence resumes the **pipeline state**; the user's
  next Claude Code session reads `cadence runs show <ulid>` and resumes from
  the recorded boundary.
- **Auto-rolling-back side effects.** Resume can `skip-already-applied`,
  `retry`, or `needs-human`. It never reverts.
- **Streaming dashboard / web UI.** `runs watch <id>` already exists; this
  spec doesn't change it.

## Current state (factual scan, base_sha 34e0bd8)

### What's already wired

`src/cli/autopilot.ts:runAutopilot()` ALREADY:

- Calls `createRun({ phases: [scan, spec, plan, implement, migrate, pr] })`
  with one `runId` for the whole pipeline.
- Loops over the six phases and calls `runPhase()` for each — which emits
  `phase.start` / `phase.success` / `phase.failed` events and writes
  per-phase snapshots.
- Calls `resumePreflight()` for side-effecting phases (`migrate`, `pr`)
  before invoking the phase body.
- Emits `run.complete` and refreshes `state.json` in a `finally` block.

`src/core/concurrent-dispatch/scheduler.ts` ALREADY:

- Accepts a `SerializedWriter` from `run-state/serialized-writer.ts`.
- Emits `task.started`, `task.completed`, `task.failed`, `task.merged`,
  `task.merge_conflict`, `task.timeout` to the run's events.ndjson.
- Holds the cross-process `repo.lock` via `repo-lock.ts` for merge
  operations.

### What's not wired (the gaps issue #180 names)

1. **`skills/autopilot/SKILL.md` is blind to all of this.** It documents
   nine pipeline steps as LLM-driven Bash/tool calls (`gh pr create`,
   `scripts/codex-review.ts`, `/migrate --env=dev`). None of those calls
   know about `runId` or write events. The skill's "Error Recovery" section
   says "max 3 retries"; it doesn't say "resume from the last good phase."
2. **No top-level `cadence autopilot resume <ulid>` verb.**
   `src/cli/runs.ts:runRunResume()` is **lookup-only** ("identifies which
   phase a future resume would pick up from and the decision the engine
   would make"). There is no entrypoint that:
   - Re-acquires the advisory lock for an existing runDir.
   - Calls `recoverState()` to fold events back into state.json.
   - Re-enters the orchestrator's phase loop at `state.currentPhaseIdx`.
   - Honors the `decideReplay`/`resumePreflight` decisions.
3. **The CLI's `runAutopilot()` always calls `createRun()`** — it has no
   `runId` input parameter and no path to attach to an existing run.
4. **The nine SKILL steps are mostly NOT the same as the six CLI phases.**
   SKILL Step 1 includes Codex spec review + plan writing + plan Codex
   review. CLI `spec` and `plan` phases are read-only `RunPhase`
   declarations that wrap the Cadence `spec` / `plan` verbs — they don't
   emit `phase.cost` for Codex calls because Codex calls happen OUTSIDE
   the engine, driven by the skill.
5. **Step 0 (brainstorming) and Steps 7/8 (codex-review, bugbot) are
   entirely outside the registered phase set.** `phase-registry.ts`
   explicitly excludes `brainstorm`, `review`, `validate`, `costs`, `fix`
   because they're "advisory / read-only verbs that don't fit the
   pipeline shape." That's the right design for the registry — but it
   means the SKILL pipeline crosses in and out of engine coverage on
   every step.

## The integration problem, restated precisely

The SKILL is a higher-level pipeline than the CLI's `autopilot` verb. Its
nine steps include sub-steps (Codex passes, plan writes, validation
retries, bugbot triage) that are not registered RunPhases. To make the
SKILL resumable, we have two architectural choices:

**Choice 1 — Treat the SKILL as the orchestrator; emit `phase.*` events
directly from the LLM tool calls.** The skill writes `phase.start` /
`phase.success` / `phase.failed` events itself (via a small CLI helper
verb) at each of its nine step boundaries. No registered RunPhase is
needed; the skill is the contract. Pro: simple, direct, the skill IS the
pipeline. Con: the LLM is now responsible for event integrity. If it
forgets to call the helper, the state is wrong.

**Choice 2 — Decompose the SKILL into registered RunPhases.** Each of
the nine steps becomes a `RunPhase` registration with declared
`idempotent` / `hasSideEffects` flags. The skill becomes a thin LLM
wrapper that calls `cadence autopilot --phases=brainstorm,spec,plan,...`
and lets the engine drive. Pro: the engine enforces correctness; resume
is automatic. Con: large rewrite — the LLM-driven Codex / bugbot /
brainstorming sub-steps need to be lifted into RunPhase bodies, which is
non-trivial because they interleave LLM tool calls with user approval
gates that don't fit the engine's `run(input) → output` shape.

**Recommendation: hybrid (see Phase B below).** Phase A is spec-only; it
commits to the hybrid direction but does not write the integration code.

## Resume execution model (load-bearing decision)

> Codex pass 1 (CRITICAL #1) surfaced that "resume" means two
> different things across this spec. This section pins down ONE model
> and the spec's phase B/C builds on it from here.

There are TWO classes of phase in the SKILL pipeline:

- **Engine-executed phases** — `migrate`, `pr`. These are registered in
  `PHASE_REGISTRY` with typed `RunPhase` builders, declared idempotency
  contracts (`preEffectRefKinds` / `postEffectRefKinds`), and existing
  resume preflight wiring. Resume of these phases is a code path:
  `cadence autopilot resume <ulid>` re-acquires the lock, recovers
  state, and re-enters the orchestrator's phase loop. The engine itself
  decides skip / retry / needs-human via `decideReplay` +
  `resumePreflight`.
- **LLM-driven phases** — `brainstorm`, `plan`, `branch`, `impl`,
  `validate`, `codex-review`, `bugbot`. These are NOT registered in
  `PHASE_REGISTRY`. Their bodies are LLM tool calls inside the Claude
  Code agent following SKILL.md. The CLI cannot execute them.

These two classes share ONE events.ndjson stream but resume through
different paths:

**Engine-executed phase resume — automatic.**
`cadence autopilot resume <ulid>` walks the phase list. For an
engine-executed phase, it calls the registered builder and invokes
`runPhase` exactly as the orchestrator's normal forward path does. The
existing replay-decision + resume-preflight machinery handles
skip-already-applied / retry / needs-human routing.

**Engine phase invocation in SKILL-created runs (load-bearing).**
A SKILL-created run does NOT carry the typed phase inputs that the
CLI's six-phase orchestrator passes between phases (e.g. `migrate`
expects a `MigrateInput` populated by `plan`'s output). For SKILL
runs, the engine-executed phases (`migrate`, `pr`) are invoked via a
**run-phase entry-point** added in Phase B (NOT a direct SKILL helper
call — see CRITICAL #2 below):

```
cadence autopilot run-phase --run-id <ulid> --phase migrate [phase-specific flags]
cadence autopilot run-phase --run-id <ulid> --phase pr      [phase-specific flags]
```

This is the SAME `runPhase`-driven path the existing CLI orchestrator
uses, but it accepts a runId + phase name and reconstructs the phase
input from:

1. The persisted `skill-manifest.json` (phase metadata).
2. Phase-specific CLI flags forwarded to the registered builder
   (`migrate`: `--env`, `--migrations-dir`; `pr`: `--title`, `--body`,
   `--base`). The flag set matches the existing per-verb CLI verbs
   (`cadence migrate`, `cadence pr`) — the registered builders already
   accept these.
3. Optional artifact references emitted by prior phases (e.g. the
   `plan` phase persisted the plan path; `migrate` reads it from
   `<runDir>/artifacts/plan.md` when the manifest declares it).

**Required inputs per engine phase (Phase B must specify and test):**

| Phase | Required inputs | Source in SKILL run | Error if missing |
|---|---|---|---|
| `migrate` | `cwd`, `env` (defaults `dev`), `migrationsDir` (defaults `data/deltas/`) | CLI flags; defaults match existing `cadence migrate` defaults | `invalid_config` with the missing flag named |
| `pr` | `cwd`, `title`, `body`, `baseBranch`, `headBranch` | CLI flags; SKILL Step 6 already computes these — passes them through | `invalid_config` with the missing field |

If a required input is missing the run-phase verb exits with
`invalid_config` and emits NO events (it never enters runPhase). This
is the deterministic contract that makes resume safe.

**Input-snapshot persistence (CRITICAL per Codex pass 3 #1).** When
`cadence autopilot run-phase` first invokes an engine phase, BEFORE
`runPhase` is called, it persists the resolved input bundle:

```
<runDir>/inputs/<phase>.json     # canonical input shape, prettified JSON
```

The file is written atomically (tmp + rename + fsync). A SHA-256 of
the content is recorded in the events stream as
`phase.input-snapshot { phase, phaseIdx, sha256, path }` — a new
purely-additive event under Appendix A. `Phase C resume` reads
`<runDir>/inputs/<phase>.json` and passes its contents to the
registered builder; no flags are required at resume time. If the
file is missing the resume verb exits `needs_agent` with a
resume-plan instructing the SKILL to re-invoke `run-phase` with the
right flags (so the input snapshot gets written before the engine
runs).

Tests required in Phase B/C: resume of a SKILL-created run at
`migrate` and `pr` with NO prior CLI six-phase snapshots. The
`run-phase` entry-point must work standalone. Plus a crash-injection
test: kill the process AFTER input snapshot is written but BEFORE
runPhase emits `phase.success` — resume must use the persisted
inputs and produce the same outcome as the original invocation.

**LLM-driven phase resume — guided diagnostic.**
`cadence autopilot resume <ulid>` MUST refuse to execute an LLM-driven
phase. Instead it produces a deterministic JSON `resume-plan` that the
NEXT Claude Code session reads and follows. The plan names:

- The next phase to run, by SKILL step number + phase name.
- The decision the engine would make if the phase were
  engine-executed (`retry` / `skip-already-applied` / `needs-human`)
  based on persisted metadata.
- Specific artifact paths (spec, plan, PR URL, last test report) the
  LLM should re-read to reconstruct context.
- An explicit instruction: "this phase's body is LLM-driven; the
  agent must re-perform it OR mark it complete after verifying the
  external state."

In other words: for LLM phases, the engine is the bookkeeper, not the
executor. The Claude Code session driving the SKILL is the executor and
reads the engine's recommendation. This is the only safe design — the
engine cannot LLM-call its way through `bugbot` or `brainstorm`.

**Implication for the CLI verb name.** `cadence autopilot resume` is
fine for engine-executed phases. For mixed runs, it prints the
resume-plan JSON, exits with a documented `needs_agent` exit code, and
the SKILL handles the rest. Phase C below makes this the load-bearing
spec for the CLI verb.

## Architecture: Phases A, B, C

### Phase A — spec PR only (this RFC)

**Scope:** Commit this design doc as `RFC #180`. Open a PR titled
`spec: v6 run-state integration into autopilot skill (RFC #180)`. Run
risk:high Codex passes (3) on the spec content. No engine changes, no
CLI changes, no SKILL.md changes. STOP after spec lands.

**Why halt here:** This is a load-bearing architectural decision
(checkpoint/resume governs production-affecting work, side-effecting
phases like `migrate` and `pr` must replay correctly, the
`forceReplay` override is a footgun). The user wants design review
BEFORE implementation.

**Deliverable:** `docs/superpowers/specs/2026-05-26-issue-180-run-state-integration-design.md`
(this file). PR description references #180 as an RFC.

### Phase B — SKILL instrumentation + engine foundation (follow-up PRs)

**Scope:** Phase B is itself larger than originally framed (per
Codex pass 5 WARNING). Phase B's plan PR should decompose it into at
LEAST three sub-PRs:

- **B1: Manifest + helper lifecycle events.** `cadence internal
  run-event` (begin-run, start, success, fail, abort, heartbeat,
  complete-run), `skill-manifest.json` persistence, capability
  declaration, schema-version 3 bump. SKILL.md additions for
  LLM-driven phase instrumentation only. No `run-phase`, no
  input-snapshot, no resume.
- **B2: Shared transition API + leases + `runs show` derivation.**
  Refactor `runPhase` to call `applyPhaseTransition`. Lease files
  with heartbeat. Stale-lease recovery transitions. `runs show`
  status derivation per Appendix B.
- **B3: Engine phase entry-point + input snapshots.** `cadence
  autopilot run-phase`, `<runDir>/inputs/<phase>.json` persistence,
  `phase.input-snapshot` events. SKILL.md updates Step 5 (migrate)
  and Step 6 (pr) to invoke `run-phase`.

Phase C (resume) builds on B1+B2+B3.

**Scope (B1-B3 combined):** Add a new internal CLI verb `cadence
internal run-event` (or similar; final name TBD in Phase B's spec)
that the SKILL invokes at each step boundary. The SKILL emits
`phase.start` / `phase.success` / `phase.failed` events via this
helper. No resume yet — this lays the foundation by ensuring every
run has events on disk.

**Canonical phase list (frozen here for the rest of the spec):**

The SKILL pipeline crystallizes as EXACTLY these nine phases, in this
order. `currentPhaseIdx` indexes this array. Both Phase B (`begin-run`)
and Phase C (`autopilot resume`) MUST use this list verbatim.

```
0  brainstorm        # Step 0 of SKILL.md
1  plan              # Step 1 of SKILL.md (spec-validation + plan-write)
2  branch            # Step 2 of SKILL.md (feature branch ref)
3  impl              # Step 3 of SKILL.md (concurrent dispatch)
4  validate          # Step 4 of SKILL.md
5  migrate           # Step 5 of SKILL.md (engine-executed; registered)
6  pr                # Step 6 of SKILL.md (engine-executed; registered)
7  codex-review      # Step 7 of SKILL.md
8  bugbot            # Step 8 of SKILL.md
```

Step 9 (Report) is NOT a phase — it's the SKILL's final status print
that fires `run.complete`. The numbering "nine phases + final report"
matches the SKILL.md headings exactly.

**Phase metadata (durable; persisted at `begin-run` time):**

`begin-run` MUST persist per-phase metadata so Phase C's resume logic
has the inputs `decideReplay` and `resumePreflight` need. Loose phase
names without metadata are forbidden in resumable runs. The shape:

```ts
interface SkillPhaseManifestEntry {
  name: string;                      // see canonical list above
  executor: 'engine' | 'llm-driven'; // who runs the phase body
  idempotent: boolean;
  hasSideEffects: boolean;
  preEffectRefKinds: ExternalRefKind[];   // empty for non-side-effecting
  postEffectRefKinds: ExternalRefKind[];  // empty for non-side-effecting
}
```

For the canonical nine phases:

| idx | name | executor | idempotent | hasSideEffects | preEffectRefKinds | postEffectRefKinds |
|---|---|---|---|---|---|---|
| 0 | brainstorm | llm-driven | true | false | [] | [] |
| 1 | plan | llm-driven | true | false | [] | [] |
| 2 | branch | llm-driven | true | false | [] | [] |
| 3 | impl | llm-driven | false | true | [] | [`git-remote-push`] |
| 4 | validate | llm-driven | true | false | [] | [] |
| 5 | migrate | engine | (per registry) | true | [`migration-batch`] | [`migration-version`] |
| 6 | pr | engine | (per registry) | true | [`github-pr`] | [] |
| 7 | codex-review | llm-driven | true | false | [] | [] |
| 8 | bugbot | llm-driven | false | true | [] | [`github-pr`] |

This manifest is persisted at `begin-run` time as
`<runDir>/skill-manifest.json` (alongside `state.json` and
`events.ndjson`). It is read by Phase C's resume logic. New event type
`skill.manifest.recorded` carries it for the events.ndjson source of
truth.

**Ref-direction notes (per Codex pass 3 CRITICAL #3):**

- `branch` is **`hasSideEffects: false`** (per Codex pass 4
  WARNING). Step 2 only creates a local ref — no remote push, no
  external state. `idempotent: true` covers replay safety. No ref
  kinds.
- `impl`, `bugbot` use `postEffectRefKinds` for `git-remote-push`
  and `github-pr` because those refs represent the side-effect
  AFTER it lands. Resume preflight can read them back to detect
  "already done" and `skip-already-applied`. Resume of `impl` with
  a `git-remote-push` ref pointing at the post-impl tip → skip; no
  `git-remote-push` ref → needs-human (we don't know if commits
  exist).
- `migrate` keeps the existing engine contract:
  `preEffectRefKinds: ['migration-batch']` (the batch breadcrumb
  recorded BEFORE applying) + `postEffectRefKinds:
  ['migration-version']` (per-version refs recorded after each
  apply).
- **`pr` is intentionally `preEffectRefKinds: ['github-pr'],
  postEffectRefKinds: []`** — this matches the EXISTING engine
  contract in `src/core/run-state/phase-registry.ts` (see comment
  "The github-pr ref is recorded pre-effect with the same id gh
  reports post-create — it serves both purposes"). The github-pr
  ref is generated by `gh pr create` at the moment of side-effect
  application; the engine records it AS the pre-effect breadcrumb
  because there's nothing to record before the API call. The
  pre-effect ref doubles as the reconciliation ref: resume reads it
  back via `gh pr view <id>`; `open`/`merged`/`closed` all signal
  the PR exists → `skip-already-applied`. This spec MUST NOT change
  the `pr` registration; touching it would require a separate engine
  spec.

`branch` is `idempotent: true, hasSideEffects: false` — local branch
creation is treated as replay-safe local state, not an external
side effect (per Codex pass 5 CRITICAL #2; this is the canonical
value to ship in `src/core/skill-manifest/canonical.ts`). `impl` and
`bugbot` are `idempotent: false` because their bodies dispatch
subagents that commit; replay without the post-effect ref would
duplicate.

**Deliverables:**

1. `cadence internal run-event start --run-id <ulid> --phase <name>`
2. `cadence internal run-event success --run-id <ulid> --phase <name> [--cost-usd <n>]`
3. `cadence internal run-event fail --run-id <ulid> --phase <name> --error <msg> [--error-code <code>]`
4. `cadence internal run-event abort --run-id <ulid> --phase <name> --reason <user-interrupt|crash|budget-exceeded|lock-takeover>`
5. `cadence internal run-event complete-run --run-id <ulid> --status <success|failed|aborted> [--terminal]` — terminal event; required by `run.complete` contract. Per Codex pass 4 WARNING: `--status success` is the SKILL's normal Step 9 path. `--status failed` REQUIRES the `--terminal` flag and is fail-closed by default — without `--terminal` the SKILL cannot mark a run terminally failed; it must either resume or call `cadence runs abort` (which has its own confirmation prompt). SKILL retry exhaustion in Steps 4/7/8 does NOT call `complete-run --status failed`; it leaves the run paused so the user can choose `resume`, `mark-succeeded`, or `runs abort`.
6. `cadence internal run-event ref --run-id <ulid> --phase <name> --kind <ExternalRefKind> --id <ref-id> [--url <u>] [--provider <p>]` — emit `phase.external-ref` for LLM-driven phases ONLY (per Codex pass 5 WARNING — `migrate` / `pr` refs are emitted exclusively by the engine inside `run-phase`). Example uses: SKILL Step 3 (`impl`) emits a `git-remote-push` ref AFTER the push lands, recording branch + commit SHA; SKILL Step 8 (`bugbot`) emits a `github-pr` ref after pushing fixes.
7. `cadence internal run-event begin-run [--run-id <ulid>] [--config <json-file>]`
   - WITHOUT `--run-id`: creates a new run with the canonical
     nine-phase list AND the canonical phase manifest baked in.
     Prints the new ULID to stdout. Emits `run.start` +
     `skill.manifest.recorded`.
   - WITH existing `--run-id`: re-acquires lock, calls
     `recoverState`, validates the persisted manifest matches the
     binary's current canonical list (errors `manifest_mismatch` if
     not), checks all `phases/*.lease.json` files — if any lease is
     LIVE (per the staleness rules), exits with `phase_running`
     (per Codex pass 4 WARNING) and does NOT mutate the run. Stale
     leases are deleted as part of normal recovery; live leases
     block attach. Prints the existing runId. Does NOT re-emit
     `run.start`.
8. New CLI entry-point `cadence autopilot run-phase --run-id <ulid>
   --phase <migrate|pr> [phase-flags]` per "Engine phase invocation"
   section above. This is THE way SKILL Steps 5/6 execute their
   phases. It owns the lifecycle: acquires the run lock, invokes
   `runPhase()` with the resolved input, and emits the canonical
   engine-owned `phase.start` / `phase.success` / `phase.failed` events
   from inside `runPhase`. Phase B ships this verb even though
   `autopilot resume` lands in Phase C — it's needed for SKILL Steps
   5/6 to be engine-executed.
9. **Event-ownership rule (hard contract):** `cadence internal
   run-event start/success/fail/abort/ref` REJECT phases declared
   `executor: engine` in the manifest. Lifecycle AND external-ref
   events for engine phases are emitted EXCLUSIVELY by `runPhase`
   (via `cadence autopilot` or `cadence autopilot run-phase`). The
   helper verb refuses with exit code `engine_phase_lifecycle` if
   the SKILL calls any helper transition for `migrate` or `pr`. This
   closes the untrusted-ref injection hole (per Codex pass 4
   CRITICAL #1): the LLM cannot fabricate a `migration-version` or
   `github-pr` ref that would cause `resumePreflight` to falsely
   `skip-already-applied`. `resumePreflight` continues to trust only
   refs persisted via the engine's internal append path. The helper
   does NOT have a "ref-recording for engine phases" carve-out.
10. SKILL.md additions:
    - Preflight (before Step 0): invoke `begin-run`, capture the
      ULID into `$AUTOPILOT_RUN_ID`, print to the user.
    - For LLM-driven phases (`brainstorm`, `plan`, `branch`, `impl`,
      `validate`, `codex-review`, `bugbot`): step's first action is
      `run-event start`; step's last successful action is `run-event
      success`. On retries-exhausted: `run-event fail`.
    - **External-ref instrumentation for resume-effective phases
      (per Codex pass 5 WARNING):**
      - After `impl` (Step 3) pushes the feature branch: call
        `run-event ref --phase impl --kind git-remote-push --id
        <remote>/<branch>@<sha>` so resume preflight can verify the
        push.
      - After `bugbot` (Step 8) pushes fixes: call `run-event ref
        --phase bugbot --kind github-pr --id <pr-number>` so
        resume preflight can verify the PR commits.
      - Without these refs the phases route to `needs-human` on
        resume, which is safe but reduces resume effectiveness.
    - For engine-executed phases (`migrate`, `pr`): step invokes
      `cadence autopilot run-phase --run-id $AUTOPILOT_RUN_ID --phase
      <name> [flags]` and does NOT call `run-event start/success`
      or `run-event ref`. The engine emits those events internally.
    - Step 9 (Report) end: `run-event complete-run --status success`
      (or `failed` on terminal failure path).
11. A new "Recovery from mid-flight failure" section in SKILL.md that
    instructs the LLM how to use `cadence runs list` / `runs show` to
    diagnose. Phase B does NOT introduce `cadence autopilot resume
    <ulid>` — Phase B is instrumentation + `run-phase` only; resume
    execution lands in Phase C.
12. **`runs show` status derivation (per Appendix B) lands in Phase
    B.** Phase B owns both event instrumentation AND the read-only
    status derivation rules required by its test plan. This was
    previously ambiguous (per Codex pass 2 WARNING); pinning it here.

**Idempotency contract for the helper:**

- `begin-run` with an existing `--run-id` is a no-op (returns the existing
  state, does NOT re-emit `run.start`).
- `begin-run` with no `--run-id` always generates a fresh ULID.
- `start` is allowed from:
  - `pending` (attempt = 1; the normal forward path).
  - `failed` or `aborted` (attempt = N+1; explicit retry).
  - `running` ONLY if the prior phase lease is stale (see "Phase
    lease" below). Stale-lease start emits a synthetic
    `phase.aborted { reason: 'crash' }` for the prior attempt
    BEFORE the new `phase.start`, so the events stream is internally
    consistent. From an active (live-lease) `running` state, `start`
    is REJECTED with `invalid_transition` — a second process cannot
    overwrite an in-flight phase.
- `success` / `fail` / `abort` for a phase that is not currently
  `running` is rejected with exit-code `invalid_transition`.
- All helper invocations use the shared `applyPhaseTransition` API
  (Appendix C2). The API acquires the run advisory lock for the
  duration of EACH event write, uses `SerializedWriter` to append,
  and validates the state-machine transition before emitting. This
  is the SAME contract concurrent-dispatch uses; no new locking
  primitives.
- **Phase ordering invariant.** `start` is allowed only for the
  current phase (`state.currentPhaseIdx`) or a previously-failed /
  aborted phase at index `<= currentPhaseIdx`. Starting phase `N` when
  any phase `0..N-1` is in `pending` or `running` state is rejected
  with `invalid_transition`. This prevents the LLM from
  hallucinating its way past a required step. Same rule applies to
  `runs mark-succeeded`.

**Unified lock + lease contract (per Codex pass 4 WARNING).**

There are exactly TWO mechanisms, used for distinct purposes:

| Mechanism | Scope | Purpose | Held by |
|---|---|---|---|
| Run advisory lock (`<runDir>/.lock` via `proper-lockfile`) | Per state mutation | Serialize event writes + recovery | Helper verbs and `runPhase` for the duration of each transition — never held across LLM tool calls or `gh`/`npm` subprocesses |
| Phase lease (`<runDir>/phases/<phase>.lease.json`) | Per in-flight phase | Represent "this phase is executing right now" — for BOTH LLM-driven and engine-executed phases | Created at `phase.start`, heartbeated, deleted at `phase.success/failed/aborted` |

Specifically: `cadence autopilot run-phase` (engine path) creates a
lease just like `run-event start` does, heartbeats internally for
long-running phases (the engine emits heartbeat events from inside
`runPhase` at most every 30s), and releases on terminal event. The
engine NEVER holds the advisory lock for the duration of a phase —
that lock is too coarse and would block concurrent reads via `runs
show`. `autopilot resume` reads ALL leases before mutating state; any
live lease → `phase_running`.

**Phase lease detail (CRITICAL per Codex pass 3 #2).** The run
advisory lock is a short-lived file lock taken only during event
writes — it does NOT represent an in-flight LLM phase. Phase B
introduces a **phase lease** for `running` phases that ARE durable
enough to survive between helper invocations:

- On `run-event start`: write
  `<runDir>/phases/<phase>.lease.json` with `{ runId, phase,
  phaseIdx, pid, hostHash, sessionId, startedAt, heartbeatAt, ttlMs
  }`. `sessionId` is a UUID identifying the SKILL agent invocation
  (passed via `--session-id`; the SKILL generates it once per run).
- The SKILL emits a lightweight heartbeat at least every 60s:
  `cadence internal run-event heartbeat --run-id <ulid> --phase
  <name>`. The helper updates `heartbeatAt` in the lease file.
  Heartbeats fail-soft: if the helper isn't installed, the SKILL
  continues; lease expires by TTL.
- On `run-event success` / `fail` / `abort`: delete the lease file.
- A lease is considered "stale" when `Date.now() - heartbeatAt >
  ttlMs * 2` (default ttl 60s → stale after 120s without heartbeat)
  OR when the recorded PID is not a live process on the recorded
  host AND the recorded host matches the current host.
- `runs show` and `autopilot resume` consult `phases/<phase>.lease.json`
  before deciding `running` vs `paused`.
- Cross-process resume safety: if `autopilot resume` finds an
  **active (non-stale) lease** for any phase, it exits with
  `phase_running` (new exit code; see Appendix D) and does NOT
  mutate the run dir. This prevents two SKILL sessions from racing.

**Fail-closed by default (per Codex pass 1 WARNING).** Phase B is NOT
"best-effort instrumentation." If `begin-run` fails (cadence not
installed, lock taken, disk full), the SKILL aborts BEFORE Step 0 with
a clear error: "durable resume requires `@delegance/cadence` ≥ <v>;
install or set `AUTOPILOT_DISABLE_RESUME=1` to opt out." Users can
explicitly opt out by setting the env var, in which case the SKILL
runs in pre-#180 unrecoverable mode and prints a banner saying so. We
never silently disable checkpointing.

**Test plan (Phase B):**

- Unit: helper emits well-formed events; `begin-run` is idempotent on
  re-invocation with the same `--run-id`; rejects mismatched
  `--config`; rejects invalid `--phase` names (per the validation
  regex below).
- Unit: state-transition validation. `start` → `start` increments
  `attempt`. `success` after `success` returns `invalid_transition`.
  `success` without a prior `start` returns `invalid_transition`.
- Unit: `begin-run` validates the persisted manifest matches the
  binary's current canonical list; mismatched manifests return
  `manifest_mismatch` and do NOT proceed.
- Integration: SKILL invoked end-to-end produces a valid runDir with
  `run.start`, `skill.manifest.recorded`, nine
  `phase.start`/`phase.success` pairs, `run.complete`.
- Integration: SKILL with `AUTOPILOT_DISABLE_RESUME=1` skips all
  helper calls and prints the opt-out banner.
- Crash-resume: `kill -9` the SKILL mid-phase, run `cadence runs show
  <ulid>` — must report `status: paused`, `currentPhaseIdx: <correct
  N>` per the derivation rules in the "Status derivation" appendix.
- Adversarial: `begin-run` while another process holds the lock —
  exits with `lock_held`, no events written.

### Phase C — full resume verb (follow-up PR, separate plan)

**Scope:** Implement `cadence autopilot resume <ulid>` plus the
human-reconciliation verb. Together these give the user "Mac sleep
recovery" while keeping the dangerous-replay path explicit.

**Critical contract: three separate verbs, three separate semantics
(per Codex pass 1 CRITICAL #4).** Conflating them was the single
biggest design risk in the v1 draft.

| Verb | What it does | Failure-mode if misused |
|---|---|---|
| `cadence autopilot resume <ulid>` | The safe default. Walks phases. Engine-executed succeeded phases auto-skip; engine-executed unsafe phases route to `needs-human` and print the resume-plan JSON. LLM-driven phases ALWAYS print the resume-plan JSON and exit with `needs_agent` — never executed by this CLI. | Cannot duplicate side effects on its own; refuses to act on ambiguous state. |
| `cadence autopilot resume <ulid> --force-replay=<phase[,phase]>` | Per-phase replay override. ONLY for engine-executed phases (`migrate`, `pr`). Re-runs the phase body despite prior success. The phase's own ledger handles dedup. | Can duplicate work if the phase ledger is broken. Reserved for engine devs / recovery from corrupt ledger. |
| `cadence runs mark-succeeded <ulid> --phase <name> --reason <text>` | Human reconciliation. Marks an LLM-driven phase as already complete WITHOUT executing it. Used when the user has verified the external state (commits on branch, PR open, migration applied) and wants resume to skip past. Emits `phase.marked-succeeded` event with the human's reason. | If the user lies / mis-verifies, resume will then proceed past an actually-incomplete phase. Audit trail is the persisted reason. |

`--force-replay` is REJECTED for `llm-driven` phases. The CLI must
print: "Phase `<name>` is LLM-driven and cannot be force-replayed from
the CLI. Either mark it succeeded with `cadence runs mark-succeeded`
after verifying external state, or run the SKILL again under a new
runId." There is no whole-run `--force-replay`; it is always
per-phase.

**Deliverables:**

1. New CLI verb `cadence autopilot resume <ulid>`.
2. New CLI verb `cadence runs mark-succeeded <ulid> --phase <name>
   --reason <text>`.
3. New CLI verb `cadence runs abort <ulid> --reason <text>` — explicit
   terminal-failure path. Acquires the lock, emits `run.complete {
   status: 'aborted' }`, releases lease files. This is the ONLY
   user-driven path to terminal `run.complete` status per Codex pass
   3 CRITICAL #4.
4. New function `runAutopilotResume({ runId, cwd, forceReplayPhases })`
   in `src/cli/autopilot.ts`. It must:
   - Validate the runId is a real ULID.
   - Locate the runDir via `runDirFor(cwd, runId)`.
   - **Lock contract (per Codex pass 5 CRITICAL #1):** Acquire the
     advisory lock ONLY for the recovery + decision-emit phase, then
     RELEASE it before entering the phase execution loop. The phase
     loop relies on `applyPhaseTransition` to re-acquire the lock
     per transition (its existing contract). For exclusivity during
     phase execution, the engine relies on **leases** — `resume`
     refuses to proceed if ANY live lease exists, and creates leases
     itself when executing engine phases via `run-phase`. The
     advisory lock is NEVER held across `runPhase` invocations.
   - Acquire lock; check all phase leases — any live lease → release
     lock, exit `phase_running`.
   - Call `recoverState(runDir, { writerId: lock.writerId })` to fold
     events back into a valid state.json. As part of recovery: for
     each phase with `phase.start` but no terminal event AND no live
     lease, emit a synthetic `phase.aborted { reason: 'crash' }`
     (per Codex pass 5 WARNING — recovery-as-transition, not just
     file deletion). Delete the stale lease file after the abort
     event lands.
   - Read `skill-manifest.json` to determine `executor` for each
     phase. Reject runs missing the manifest with
     `missing_skill_manifest` (the run was created by an older
     Cadence; user must restart, can't resume) — see also the
     "Resume support matrix" below for legacy CLI-created runs.
   - Release the lock before entering the phase loop.
   - For each phase in canonical order:
     - If `state.phases[i].status === 'succeeded'`, skip silently
       (NO new event emission per Codex pass 1 WARNING; resume-time
       observations are not phase transitions).
     - (Status `'marked-succeeded'` does NOT exist; marked phases
       have `status: 'succeeded'` with event metadata `source:
       'human'`. The standard `succeeded` branch above handles them.)
     - For non-succeeded phases with `executor: engine`: FIRST
       resolve the input snapshot:
       - Read `<runDir>/inputs/<phase>.json`. If missing → exit
         `needs_agent` with a resume-plan instructing the SKILL to
         invoke `cadence autopilot run-phase --run-id <ulid> --phase
         <name> [flags]` so the engine writes a fresh input snapshot
         before retrying. Do NOT auto-execute the phase from
         ambient state.
       - Verify the file's SHA-256 against the latest
         `phase.input-snapshot` event. Mismatch → exit
         `invalid_config` with `corrupted_input_snapshot`. Refuse to
         proceed with potentially-tampered inputs.
       - On match: call `decideReplay()` + `resumePreflight()` with
         the snapshot inputs. Standard engine path — skip, retry, or
         needs-human per the matrix. `forceReplayPhases` overrides
         for the named phases. The registered builder receives the
         exact input bundle from the JSON file; no flags required.
       (Per Codex pass 4 CRITICAL #2 — input-snapshot is the source
       of truth for resume; ambient flags are NEVER inferred at
       resume time.)
     - For non-succeeded phases with `executor: llm-driven`: NEVER
       execute. Instead, write a `resume-plan` JSON object to stdout
       (or stderr-as-prefixed-banner when not in `--json` mode)
       describing the next action the SKILL agent should take, and
       exit with code `needs_agent`. The resume-plan emits a single
       `resume.decision` event for auditability.
   - On any engine-executed phase failure: the failure stays
     resumable. `runPhase` emits `phase.failed`; `runAutopilotResume`
     does NOT emit `run.complete`. The run stays in `paused` status
     (per Appendix B derivation). The verb exits non-zero with
     `phase_failed`. Re-invoking `autopilot resume <ulid>` will
     attempt the phase again (subject to `decideReplay`).
   - `run.complete { status: 'failed' }` is reserved for terminal
     run abandonment: user-driven `cadence runs abort <ulid>`,
     unrecoverable corruption, or `--no-resume` explicit flag.
     Transient phase failures must NEVER write the terminal event
     (per Codex pass 3 CRITICAL #4).
   - On reaching the end of the phase list with all phases succeeded
     / marked-succeeded / skipped, the verb emits `run.complete {
     status: 'success' }` and exits 0.
4. `runs mark-succeeded` implementation:
   - Acquires the run lock.
   - Validates `--phase` is in the canonical list AND the
     phase-ordering invariant (no earlier phase still
     pending/running).
   - Refuses if the phase already has `phase.success`
     (`already-succeeded`).
   - Refuses if the phase is engine-executed AND has unresolved
     post-effect refs (`use --force-replay or resume normally`).
   - **Calls `applyPhaseTransition` with `transition:
     'mark-succeeded'`** — an explicit state-machine transition. The
     shared API:
     - Accepts source states `pending`, `failed`, or stale-`running`.
     - Emits a synthetic `phase.start { attempt: N+1, source:
       'human-mark' }` event FIRST (so the events stream stays
       internally consistent — every success has a matching start),
       then `phase.success { source: 'human', markedReason: reason }`
       (per Codex pass 2 CRITICAL #3 — additive metadata, no new
       status enum).
     - Updates state.json's phase status to `succeeded` with `source:
       'human'` recorded on the snapshot.
   - This explicit transition is tested in `applyPhaseTransition`'s
     unit suite (per Codex pass 3 WARNING — mark-succeeded is a
     first-class transition, not a bypass).
5. SKILL.md additions:
   - The "Recovery from mid-flight failure" section names the three
     verbs and when to use each.
   - A "Resume safety checklist" subsection: (1) read `cadence runs
     show <ulid>` first, (2) verify external state matches state.json
     (PR exists if `pr` recorded success, migration applied if
     `migrate` recorded success), (3) prefer `mark-succeeded` over
     `--force-replay` for LLM phases, (4) prefer plain `resume` over
     `--force-replay` for engine phases.
6. `--force-replay` mechanics:
   - Per-phase only: `--force-replay=<csv>`. Whole-run override is
     not supported.
   - Rejected for `executor: llm-driven` phases with the explicit
     error above.
   - Emits a `run.warning { kind: 'force-replay-override', phases:
     [...] }` event BEFORE entering the phase loop, naming the phases
     to be force-replayed.
   - Prints a multi-line stderr warning naming each phase and its
     persisted externalRefs that would normally route to
     `needs-human`.
   - **`--force-replay=pr` safety guard (per Codex pass 4 WARNING).**
     The `pr` registered builder MUST, before calling `gh pr create`,
     read back any recorded `github-pr` ref via `gh pr view <id>` and
     short-circuit if the PR exists (open/merged). Force-replay does
     not bypass this guard — it overrides the engine's preflight
     decision, NOT the phase body's own idempotency check. This is
     a pre-existing engine invariant; Phase C's spec only references
     it. If the engine implementation lacks this guard today, Phase
     C must add it before allowing `--force-replay=pr`.
   - **`--force-replay=migrate` safety guard.** Same pattern: the
     migrate dispatcher's per-`migration-version` ledger detects
     already-applied versions and skips them. Force-replay surfaces
     a re-attempt; the ledger prevents double-apply.

**`resume-plan` schema (Phase C event payload + stdout shape):**

```ts
interface ResumePlan {
  runId: string;
  nextPhaseIdx: number;
  nextPhaseName: string;
  nextPhaseExecutor: 'engine' | 'llm-driven';
  decisionIfEngineExecuted: 'retry' | 'skip-already-applied' | 'needs-human';
  decisionReason: string;
  artifacts: { name: string; path: string; sha256?: string }[];
  externalRefs: ExternalRef[];
  /** Human-readable instructions for the agent. */
  instructions: string;
}
```

The `instructions` field is templated per phase. Example for `bugbot`:
"Before resuming Step 8, run `gh pr view <pr> --comments` to confirm
which bugbot findings already have replies. If commits are on the
branch already, run `cadence runs mark-succeeded <ulid> --phase bugbot
--reason '<your verification>'` instead of re-executing."

**Out of scope for Phase C:**

- Resuming **partial** phases (mid-phase crash). The engine resumes at
  phase boundaries. A crash mid-`runPhase` means the next attempt
  re-enters the phase from the start; the phase's own idempotency
  contract handles dedup.
- Resuming **concurrent-dispatch** mid-fan-out. Filed separately
  (Phase D). Today the scheduler is a single-shot function; a crash
  mid-scheduler restart from the parent `runPhase` re-dispatches all
  tasks. The scheduler's per-task events ARE in the same events.ndjson,
  so a future implementation can be additive.

**Test plan (Phase C):**

- Unit: `runAutopilotResume` skips succeeded phases without emitting
  events; routes engine-executed phases per `decideReplay`; routes
  LLM-driven phases via resume-plan JSON.
- Unit: `--force-replay=impl` is REJECTED (impl is llm-driven).
- Unit: `--force-replay=migrate` is accepted; emits `run.warning`;
  invokes runPhase normally.
- Unit: `runs mark-succeeded` refuses already-succeeded phases;
  refuses engine phases with unresolved refs.
- Integration: run a full pipeline, `kill -9` between Step 5 (migrate)
  and Step 6 (PR), then `cadence autopilot resume <ulid>` — must skip
  Steps 0-5 and re-execute Step 6 via engine.
- Integration: resume after `pr` phase succeeded — must
  `skip-already-applied` because the github-pr ref reads back as `open`
  / `merged`.
- Integration: resume after `migrate` succeeded but `pr` failed — must
  resume at `pr`, skip `migrate` (idempotent + post-effect refs
  verify).
- Integration: resume with last completed phase = `impl` (succeeded),
  next phase = `validate` (pending) — `validate` is llm-driven → exits
  with `needs_agent`, prints resume-plan JSON pointing the SKILL at
  Step 4.
- Integration: SKILL reads the resume-plan JSON, calls `run-event
  start` for `validate`, runs Step 4, calls `run-event success`, and
  the next `cadence autopilot resume <ulid>` correctly advances to
  `migrate`.
- Adversarial: corrupt `state.json`, run `resume` — `recoverState` must
  fold events.ndjson and continue.
- Adversarial: hold the lock from another process, run `resume` — must
  exit with `lock_held` and not mutate the run dir.
- Adversarial: missing `skill-manifest.json` — exit with
  `missing_skill_manifest`, no events.

## How the SKILL maps to engine phases (canonical reference)

See the canonical phase list and metadata table in the Phase B section
above. The summary points:

- **`impl` and `bugbot` are `hasSideEffects: true, idempotent: false`,
  `executor: llm-driven`.** Resume routes them to a resume-plan JSON
  exit (`needs_agent`). The user reconciles via `cadence runs
  mark-succeeded` or re-runs the SKILL phase manually under the same
  runId.
- **`migrate` and `pr` are `executor: engine`** with the existing
  registry contracts. Their `externalRef`s carry enough state for
  `resumePreflight` to decide `skip-already-applied` correctly.
- **The first three phases (`brainstorm`, `plan`, `branch`) are cheap
  enough to safely re-run on resume.** `idempotent: true` makes the
  engine produce a resume-plan that says "rerun is safe" — for
  `llm-driven` phases the agent still chooses, but the recommendation
  is `retry` not `needs-human`.

## Resume support matrix — SKILL runs vs CLI six-phase runs

Per Codex pass 5 WARNING. Two distinct kinds of run can exist on
disk:

| Run origin | Manifest? | Capabilities? | Resume supported? |
|---|---|---|---|
| SKILL-created (Phase B+) | yes (`skill-manifest.json`) | yes (`['skill-manifest', ...]`) | YES — `cadence autopilot resume <ulid>` is the primary use case. |
| Legacy CLI `cadence autopilot --mode=full` (Phase A binary, six phases) | no | no | NO — `cadence autopilot resume <ulid>` exits with `missing_skill_manifest`. The user must restart with a fresh run. Phase D may add legacy-resume support deriving phase metadata from `PHASE_REGISTRY` instead of the manifest. |
| Single-verb CLI invocations (`cadence migrate`, `cadence pr`) under engine-on | no, single-phase | n/a | NO — single-phase runs have nothing meaningful to "resume." The verb either succeeded or failed; user re-invokes the verb. |

Phase C SKILL.md "Recovery from mid-flight failure" section names
this matrix explicitly so users know which runs are resumable.

## Concurrent-dispatch (#181 territory; called out for completeness)

The v7.11.0 concurrent dispatcher EMITS task.* events to the run's
events.ndjson via the shared SerializedWriter. A scheduler crash
mid-fan-out is, today, equivalent to the parent `impl` phase failing —
the `impl` RunPhase re-dispatches the scheduler from scratch on resume.

A finer-grained resume — re-attach to in-flight subagents, cherry-pick
the commits the previous scheduler already merged — is interesting but
out of scope for #180. Calling this out so future readers don't think
the gap is hidden.

**Phase D follow-up (separate issue):** scheduler resume protocol. When
a scheduler crashes, the next `impl` attempt should fold `task.*`
events to identify:

- `merged` tasks — skip (already on the feature branch).
- `completed-but-unmerged` tasks — call mergeOrchestrator only.
- `in-flight` tasks — re-dispatch.

This is roughly 300-500 LOC inside the scheduler. Worth doing once
Phase C ships and we see how often impl-phase crashes happen in
practice.

## Risk classification

**High** — touches autonomous behavior, governs resume semantics on
production-affecting phases, integrates with state persistence, and
introduces a `--force-replay` override that, if misused, could
double-apply migrations or duplicate PRs.

### Specific risk callouts (each demands a hard answer in Codex pass)

1. **`forceReplay` is a footgun for `pr` and `migrate`.** A user who
   force-replays `migrate` after it succeeded would attempt to re-apply
   versions that already landed. Mitigation: the migration dispatcher's
   own per-version ledger detects this. But documenting and surfacing
   the warning is load-bearing. *Codex CRITICAL gate: confirm the
   migrate dispatcher's pre-apply ledger check is in place and tested
   in the resume path.*
2. **Lock takeover semantics.** If a previous run holds the advisory
   lock but the process is dead (Mac kernel killed it), the next
   `resume` must detect stale-PID and steal the lock. `proper-lockfile`
   handles this via PID liveness checks, but the lock-takeover path
   should emit `phase.aborted { reason: 'lock-takeover' }` for
   observability. *Codex pass should confirm this is tested.*
3. **Schema-version migration on resume.** A run created by an older
   binary (`schema_version: 1`) may be resumed by a newer one
   (`schema_version: 2`). `state.ts` declares `RUN_STATE_MIN_SUPPORTED
   _SCHEMA_VERSION = 1`, so this is supported, but the resume verb
   must surface the version in `runs show` so operators can verify.
4. **Skill drift vs CLI phase registry.** Phase B introduces phase
   names that are NOT in `PHASE_REGISTRY`. `cadence runs show` must
   gracefully render unknown phase names (treat them as "external"
   phases, no idempotency contract). *Codex pass must verify
   `runs.ts`'s rendering tolerates unknown phase names.*
5. **Helper verb auth / sandboxing.** `cadence internal run-event` is
   invoked by the SKILL inside the LLM's sandbox. It writes to the
   user's filesystem (`.guardrail-cache/runs/`). The SKILL must not
   accept attacker-controlled `--phase` values that could enable
   directory traversal. Mitigation: validate phase name against
   `/^[a-z][a-z0-9-]{0,63}$/` (no slashes, no dots). *Codex CRITICAL
   gate: confirm the validation.*
6. **Cost accounting integrity.** Cost emitted by SKILL helper calls
   must NOT double-count costs already emitted by `runPhase` for the
   registered phases (`migrate`, `pr`). The SKILL's `codex-review`,
   `bugbot`, `brainstorm` phases ARE outside the registry — their
   costs are net new and safe to emit. `migrate` and `pr` cost stays
   with `runPhase`. Phase B's helper must reject `phase.cost` emission
   for the six registered names. *Codex pass should confirm this.*
7. **What if the user is NOT using Cadence's `autopilot` verb at all?**
   Many users invoke the SKILL via Claude Code directly, never running
   `cadence autopilot`. Phase B's `begin-run` helper creates the runDir
   on its own — no CLI orchestrator required. This is intentional: the
   SKILL is the pipeline; the CLI verb is a power-user shortcut.

## Open questions (must be answered in Phase B / C plans, not here)

1. Should the SKILL emit `phase.cost` events for the Codex review and
   bugbot LLM calls? If yes, what cost model — token count from the
   `scripts/codex-review.ts` output, or a flat estimate? Recommend:
   parse the script output for the token usage line if available, else
   omit the cost field (better-no-data than wrong-data).
2. Should `cadence autopilot resume <ulid>` work if the runDir was
   created by Phase B's `begin-run` (i.e. by the SKILL, not by
   `runAutopilot`)? Recommend: yes — that is the primary use case.
   The engine doesn't distinguish; the only requirement is the
   `skill-manifest.json` is present.
3. Should `runs gc` delete the SKILL's runDirs? It already deletes
   runs with `status === 'success' | 'failed' | 'aborted'` older than
   N days. SKILL runs that emit `run.complete` will participate
   automatically. Runs that crash before `run.complete` stay in
   `running`/`paused` state forever — `runs doctor` (Phase 3 verb)
   should surface them. Phase B SKILL.md update should mention this.
4. (Resolved.) The `branch` phase is `hasSideEffects: false,
   idempotent: true` with no refs (per Codex pass 4 WARNING).
   Resume always falls through to "fresh attempt" which is safe
   because local-only branch creation is fully idempotent (`git
   branch -f` semantics, or skip when already pointing at sha).

## Appendix A — Event schema additions

Phase B and C introduce new event types. Cadence is on schema_version
2 (per `types.ts`). The additions below are PURELY additive — older
readers see unknown event types and ignore them per the engine's
forward-compat contract. No schema-version bump is needed.

| Event | Introduced in | Payload | Notes |
|---|---|---|---|
| `skill.manifest.recorded` | Phase B | `{ phases: SkillPhaseManifestEntry[] }` | Emitted once by `begin-run`, immediately after `run.start`. The persisted `skill-manifest.json` mirrors this event. |
| `phase.external-ref` | Phase B | `{ phase, phaseIdx, ref: ExternalRef }` | Helper-verb-emitted ref recording. Equivalent to the engine's existing internal ref recording, but invoked by the LLM. **`recoverState` MUST fold this event into the phase snapshot's `externalRefs[]` array** (per Codex pass 3 WARNING) — refs MUST survive snapshot rebuild so `resumePreflight` sees them. Phase B includes golden tests covering this. |
| `phase.input-snapshot` | Phase B | `{ phase, phaseIdx, sha256, path }` | Emitted by `cadence autopilot run-phase` BEFORE invoking the registered builder. Records the SHA-256 of the persisted `<runDir>/inputs/<phase>.json` so resume can detect drift. Purely additive. |
| `resume.decision` | Phase C | `{ phaseIdx, phaseName, plan: ResumePlan }` | Audit record of what `autopilot resume` chose. Only emitted when the verb runs (one per resume invocation). |

Phase C `runs mark-succeeded` does NOT introduce a new event type
(per Codex pass 2 CRITICAL #3). It reuses the existing
`phase.success` event with two additive optional metadata fields:

| Field | Type | Where | Meaning |
|---|---|---|---|
| `source` | `'engine' \| 'human'` | added to `PhaseSuccessEvent` | Who declared success. Defaults to `'engine'` (omitted in JSON) so existing readers see no change. |
| `markedReason` | `string` | added to `PhaseSuccessEvent` | Present only when `source === 'human'`. The reason captured by `runs mark-succeeded`. |

These additions are purely additive — the existing
`PhaseSuccessEvent` interface stays valid; the status union does NOT
change; `recoverState` requires no new branches. Older readers see a
normal `phase.success` event and treat the phase as succeeded, which
is the correct semantics. Schema-version stays at 2.

**Schema-version bump (per Codex pass 5 CRITICAL #3).** Earlier
drafts proposed additive `capabilities` to avoid a schema bump, but
older binaries don't run the capability check — they would silently
ignore the new safety-critical events and produce wrong resume
decisions. The fix is fail-closed at the schema layer:

- Phase B bumps `RUN_STATE_SCHEMA_VERSION` from `2` to `3`. `state.ts`
  declares `RUN_STATE_MIN_SUPPORTED_SCHEMA_VERSION` stays at `1` so
  Phase-B-and-newer binaries can READ older runs (forward
  compatibility for users with mixed-version runs in their cache).
- Pre-Phase-B binaries trying to READ a Phase-B-written run see
  `schema_version: 3` exceeding their `RUN_STATE_MAX_SUPPORTED_SCHEMA_VERSION
  = 2` → `corrupted_state` with the existing "downgrade resume is
  not supported" hint. This is the fail-closed behavior we want;
  older binaries CANNOT mis-resume new runs.
- `RunStartEvent` additionally gets a `capabilities: string[]` field
  recording the active subset (`'skill-manifest'`,
  `'phase-input-snapshot'`, `'phase-external-ref'`,
  `'phase-lease'`). Phase-B+ readers verify the set is
  fully-supported; unknown future capabilities → exit
  `unsupported_run_capabilities` BEFORE mutating the run dir. This
  protects against future schema_version=4 additions.
- The version bump is the load-bearing protection; the capabilities
  field is forward-defense for Phase C+ additions.

The following events ALREADY exist in `types.ts` and are reused
verbatim: `run.start`, `run.complete`, `run.warning`, `run.recovery`,
`phase.start`, `phase.success`, `phase.failed`, `phase.aborted`,
`phase.cost`, `phase.skipped` (note: NOT emitted by resume per Codex
pass 1 WARNING; only by explicit phase-runner skip decisions inside
the orchestrator). `phase.needs-human` is referenced by the engine
spec but Phase C must verify the event exists; if not, add it under
this appendix.

## Appendix B — `runs show` status derivation rules

Phase B test plan calls for `cadence runs show <ulid>` to report
`paused` after a `kill -9`. This is not automatic — `paused` is a
derived state. Phase B implements (or extends) the derivation as:

1. If `run.complete` event present → use its `status` field
   (`success` / `failed` / `aborted`).
2. For each phase, check `<runDir>/phases/<phase>.lease.json`:
   - File present AND lease NOT stale (live PID + heartbeat within
     `ttlMs * 2`) → that phase is `running`.
   - File present AND lease stale OR file absent → consult the
     event stream.
3. If any phase has a live lease per (2) → run status is `running`,
   currentPhaseIdx = that phase.
4. Else, walk events for each phase in order:
   - If last event for phase is `phase.start` with no matching
     `phase.success`/`failed`/`aborted` AND no live lease → `paused`
     at that phase, reason "crashed mid-phase, lease stale or
     missing" (per Codex pass 3 WARNING).
   - If last event for phase is `phase.failed`/`phase.aborted` →
     `paused` at that phase, reason "phase failed, resume to retry."
   - If last event is `phase.success` and there are pending phases
     remaining → `paused` between phases. (Crash-between-phases
     case.)
5. Else → `pending` (no phase has started yet).

`runs show` MUST surface the derivation reason in human-readable form
("paused: process died mid-`impl` phase, lease last heartbeat at
2026-05-26T14:32:01Z"). This is essential for the user to decide
between `resume`, `mark-succeeded`, and `--force-replay`.

## Appendix C — Helper-input validation (comprehensive)

To prevent path-traversal, log injection, and event corruption via
attacker-controlled SKILL inputs (per "Specific risk callouts" #5 +
Codex pass 2 WARNING):

| Field | Validation | Source |
|---|---|---|
| `--run-id` | strict ULID regex `/^[0-9A-HJKMNP-TV-Z]{26}$/` | All helper verbs |
| `--phase` | `/^[a-z][a-z0-9-]{0,63}$/` AND must appear in the run's `skill-manifest.json` | All helper verbs |
| `--kind` (ExternalRefKind) | enum check against `ExternalRefKind` union from `types.ts` | `run-event ref` |
| `--id` (ref id) | `/^[A-Za-z0-9._:/+=#?@-]{1,512}$/` (no shell metachars, no newlines) | `run-event ref` |
| `--url` | parseable by URL constructor; scheme MUST be `https:` or `git:` | `run-event ref` |
| `--provider` | `/^[a-z][a-z0-9-]{0,32}$/` | `run-event ref` |
| `--reason` | `/^[\x20-\x7E]{1,256}$/` (printable ASCII, no control chars) | `run-event abort`, `runs mark-succeeded` |
| `--error` | first 1024 chars, control chars stripped | `run-event fail` |
| `--config` (JSON file path) | path must resolve under `<cwd>/.claude/` or `<cwd>/.guardrail-cache/`; JSON validated against a schema | `begin-run` |
| `--status` | enum `'success' \| 'failed' \| 'aborted'` | `run-event complete-run` |
| `--cost-usd` | finite positive number; max $10000 | `run-event success` |
| Run lookup | runDir resolved via `runDirFor(cwd, runId)`; refuses to follow symlinks; refuses paths outside `<cwd>/.guardrail-cache/runs/` | All verbs |

`runs show` and the `resume-plan` renderer MUST escape these values
when embedding in stdout (no raw ANSI passthrough, no terminal
control characters, no XSS-style payloads in JSON output mode).

## Appendix C2 — Shared state-transition API

Per Codex pass 2 WARNING, the `run-event` helper MUST NOT hand-build
events. Phase B factors a single internal API:

```ts
// src/core/run-state/transitions.ts (new file)
export type PhaseTransitionKind =
  | 'start'
  | 'success'
  | 'fail'
  | 'abort'
  | 'mark-succeeded';     // human reconciliation, Phase C

export async function applyPhaseTransition(opts: {
  runDir: string;
  writerId: WriterId;
  phaseName: string;
  phaseIdx: number;
  transition: PhaseTransitionKind;
  attempt?: number;
  error?: string;
  errorCode?: string;
  reason?: string;
  costUSD?: number;
  source?: 'engine' | 'human';
  markedReason?: string;
}): Promise<void>;
```

The `'mark-succeeded'` transition (per Codex pass 5 CRITICAL #4):

- Allowed source states: `pending`, `failed`, `aborted`, or
  stale-`running` (the `abort` recovery transition runs first).
- Enforces the phase-ordering invariant: rejects if any earlier
  phase is in `pending` / `running` state.
- Emits a synthetic `phase.start { attempt: N+1, source:
  'human-mark' }` event UNDER LOCK so the events stream stays
  internally consistent, then emits `phase.success { source:
  'human', markedReason }`.
- Cleans up any existing lease file for the phase.
- Updates the phase snapshot to `status: succeeded, source:
  'human'`.

BOTH `phase-runner.ts:runPhase()` AND `cli/run-event.ts` AND `cli/runs.ts:runRunMarkSucceeded()`
call this function exclusively. It performs: state-transition
validity check, attempt-counter advancement, `SerializedWriter`
append, phase snapshot write, lock holding. Phase B's deliverable
list adds the extraction of `runPhase`'s current inline event-emit
code into this shared function as a non-behavior-changing refactor,
validated by golden tests comparing event streams pre/post refactor.

## Appendix D — Exit-code registry

Stable numeric exit codes for SKILL shell handling. Phase B adds the
new codes; Phase C adds `needs_agent`.

| Symbol | Numeric | Meaning | Retryable? |
|---|---|---|---|
| `success` | 0 | normal completion | — |
| `invalid_config` | 1 | preflight rejection (bad flag, bad input) | no — fix and re-invoke |
| `phase_failed` | 2 | a registered phase failed | yes if root cause is transient |
| `lock_held` | 3 | run's advisory lock is held by a live process | yes after lock-owning process exits |
| `needs_human` | 4 | engine declined to proceed; human inspection required | no — manual reconciliation needed |
| `phase_running` | 5 | a phase has a live (non-stale) lease — another SKILL session is in-flight | yes when the in-flight phase completes or its lease expires |
| `needs_agent` | 75 | resume produced a `resume-plan`; LLM agent must execute next phase | yes — call `autopilot resume <ulid>` after executing |
| `invalid_transition` | 80 | helper rejected an out-of-order lifecycle event | no — bug or SKILL drift |
| `manifest_mismatch` | 81 | run's `skill-manifest.json` differs from binary's canonical list | no — restart under fresh runId |
| `missing_skill_manifest` | 82 | run lacks `skill-manifest.json`; resume cannot proceed | no — restart under fresh runId |
| `engine_phase_lifecycle` | 83 | helper rejected `start/success/fail/ref` for an engine-executed phase | no — fix SKILL to call `run-phase` instead |
| `corrupted_input_snapshot` | 84 | resume's persisted phase input file mismatched its event's SHA-256 | no — investigate or restart |
| `unsupported_run_capabilities` | 85 | run declares capabilities the current binary doesn't support | no — upgrade Cadence or restart |
| `corrupted_state` | 90 | `recoverState` couldn't fold events.ndjson | requires `runs doctor` |

Phase B publishes these in `src/cli/exit-codes.ts` as a single
source of truth. SKILL.md's recovery section names each code and the
recommended response.

## Appendix E — Resume decision table for LLM-driven phases

Per Codex pass 2 WARNING — `decideReplay` is engine-specific. LLM
phases use this deterministic table inside `runAutopilotResume`:

| Phase status | Idempotent | hasSideEffects | preEffect ref present + verifiable | Decision |
|---|---|---|---|---|
| `succeeded` | — | — | — | skip silently |
| `failed` | true | — | — | retry (resume-plan: rerun the SKILL step) |
| `failed` | false | false | — | retry |
| `failed` | false | true | yes | needs-human (resume-plan: verify external state, then `mark-succeeded` or `--force-replay`) |
| `failed` | false | true | no | needs-human |
| `running` (crash detected, lock stale) | true | — | — | retry |
| `running` (crash detected, lock stale) | false | — | — | needs-human |
| `pending` | — | — | — | retry (this is the standard forward path) |

For each `needs-human` row, the resume-plan's `instructions` field
gives a phase-specific verification recipe (e.g. for `bugbot`:
"check the PR for bugbot replies posted with your runId"; for
`impl`: "verify `git log <feature-branch>` shows the expected
commits").

## Appendix F — Manifest drift CI guard

Per Codex pass 2 WARNING. Phase B adds:

1. A single TypeScript source of truth at
   `src/core/skill-manifest/canonical.ts` exporting the nine-phase
   array.
2. `cadence internal run-event begin-run` imports the canonical
   array — there is no separate runtime copy.
3. A CI test (`tests/skill-manifest-drift.test.ts`) that:
   - Parses `skills/autopilot/SKILL.md` for the "Step N: <name>"
     headings.
   - Compares the extracted ordered list against the canonical
     TypeScript array.
   - Fails if the names, order, or count diverge.
4. The SKILL.md preamble carries a `manifest_hash:` frontmatter
   field. The hash is the SHA-256 of the canonical array JSON. The
   CI test recomputes the hash and fails on mismatch — so a SKILL
   edit that changes step structure MUST also update both the
   TypeScript source and the hash.

## Appendix G — Helper verb stability boundary

Per Codex pass 2 NOTE — the `cadence internal run-event` helper is
load-bearing for SKILL.md. Declaring it `internal` would imply no
stability guarantees, but the SKILL pins to it. Resolution:

- Phase B publishes the helper under `cadence internal run-event`
  (current naming).
- Phase B's SKILL.md adds an explicit minimum-Cadence-version pin in
  its preflight check: `cadence --version >= <v>` or abort.
- The helper's `--help` output documents "this verb is the
  SKILL-stability API; backwards-incompatible changes require a
  major version bump and a SKILL.md migration." This makes it
  internal-by-name but supported-by-contract.
- An alias `cadence autopilot event` may be added in a future
  release for clarity; the `internal` prefix stays for one major
  cycle to avoid SKILL.md churn.

## Acceptance criteria (this RFC PR — Phase A)

- [ ] Spec committed at this path.
- [ ] PR opened titled `spec: v6 run-state integration into autopilot skill (RFC #180)`.
- [ ] PR description references #180 with the explicit note "this is
      a Phase A spec PR; implementation lands in follow-up PRs."
- [ ] Risk-tier confirmed `high` → three Codex passes on the spec
      content. CRITICAL findings remediated in-spec before merge.
- [ ] At least one Codex pass has weighed in on each of the seven
      "specific risk callouts" above with a verdict (or naming an
      additional risk that must be added).
- [ ] No engine code changes, no CLI changes, no SKILL.md changes in
      this PR.

## Test plan (this RFC PR)

This PR is documentation-only. The "test plan" is:

- `npx tsx scripts/validate.ts --allow-dirty` succeeds (markdown lints,
  spec frontmatter parses, no broken internal references).
- Codex 5.3 review with risk:high passes (three passes for the spec
  content; CRITICALs remediated).
- A reviewer can read the spec end-to-end and answer: "If I had to
  implement Phase B today, do I know what to build?" If no, the spec
  has not done its job.

## Out of scope (filed as follow-ups)

- Phase B implementation (separate PR + plan).
- Phase C implementation (separate PR + plan).
- Phase D scheduler resume (separate issue + spec).
- Sameness detector persistence to events.ndjson (issue #180's parent
  context references this — the v7.10.0 sameness detector is in-memory
  only; once Phase B lands, the SKILL can append fingerprints to the
  events stream so they survive resume).

## Appendix H — Mitigating LLM event-integrity risk

Per Codex pass 5 NOTE. The hybrid design depends on the LLM
correctly sequencing `start` → (work) → `success` / `fail` /
`heartbeat`. Mitigations Phase B should implement:

- Provide a thin `scripts/autopilot/run-phase-wrapper.sh` (or
  TypeScript equivalent) that the SKILL calls per phase. The
  wrapper centralizes `run-event start` invocation, sets a `trap` to
  emit `run-event fail` / `run-event abort` on signal or non-zero
  exit, runs a background heartbeat loop, runs the phase body, and
  emits `run-event success` on success. This converts "the LLM must
  remember to call helpers" into "the LLM calls one wrapper."
- A `cadence internal run-event background-heartbeat --run-id <id>
  --phase <name> --interval 30s` daemon process that the wrapper
  spawns. It exits on SIGTERM (sent by the wrapper's `success` /
  `fail` path).
- SKILL.md updates to use the wrapper for every LLM-driven phase
  rather than naked `run-event` calls. Phase B's SKILL.md edit
  drives this; manual `run-event` invocations stay supported for
  edge cases.

## Post-launch follow-ups appendix (Phase A → Phase B handoff notes)

- Naming of the helper verb: `cadence internal run-event` vs
  `cadence event` vs `cadence autopilot emit`. Recommend `cadence
  internal run-event` (under the existing `internal` subcommand
  prefix) to signal "machine-driven, not for direct human use."
- The SKILL preamble must export `AUTOPILOT_RUN_ID` to the subagent
  environment so per-task subagents (concurrent dispatch) can resolve
  the same runDir. Today the scheduler receives the runDir via
  constructor; the SKILL's helper must surface it.
- Documentation cross-links to add when Phase B/C land:
  `docs/v6/migration-guide.md` (if it exists; CHANGELOG search did not
  surface it — Phase B spec should confirm and create if missing),
  `skills/autopilot/SKILL.md`, `runs` verb help text in
  `src/cli/help-text.ts`.
