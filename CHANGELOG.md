## Unreleased — v8.1.1 target

### Added

- **Migration safety classifier (issue #179, Phase 1).** New
  `src/core/migrate/classify.ts` module + `cadence migrate classify
  --file=<path>` CLI verb classify a single SQL migration file as
  `additive` / `destructive` / `ambiguous`. Detects 16+ destructive
  forms (DROP, ALTER COLUMN TYPE/SET/DROP NOT NULL, RENAME, TRUNCATE,
  DELETE FROM, DISABLE RLS, etc.), 14+ additive forms, and 15+
  ambiguous forms (CREATE INDEX non-concurrent, GRANT, CREATE POLICY,
  CREATE TRIGGER, CREATE OR REPLACE, validated ADD CONSTRAINT, etc.).
  Multi-clause `ALTER TABLE` is reduced clause-by-clause (so
  `ADD COLUMN x, DROP COLUMN y` is destructive — `DROP COLUMN` wins).
  Lexer is quote- and dollar-quote-aware so destructive keywords
  inside string literals or PL/pgSQL bodies don't trigger.
  Annotations: `-- @autopilot: classify=additive|destructive|expand|
  contract` pins ambiguous files; `-- @autopilot:
  classify=destructive_allowed_reason=incident=<ref> <≥ 10 chars>`
  opens an emergency bypass with a required trace token. Autopilot
  Step 4.5 (between validate and migrate-dev) refuses destructive
  migrations without an explicit annotation. See
  `docs/migrations/expand-contract.md` for the operator workflow.
  Closes #179 Phase 1. Dispatcher-level enforcement (list-pending
  skill verb, manifest format, MigrationClassification artifact
  field, sanctioned contract policy) is deferred to Phase 2.

### Changed

- **Audit-log fsync policy for terminal events (issue #209).**
  `SerializedWriter` now accepts a `durability: 'never' | 'terminal' |
  'always'` option, defaulting to `'terminal'`. State-transition events
  (`task.completed`, `task.failed`, `task.merged`, `task.merge_conflict`,
  `task.merge_aborted`, `task.timeout`, `task.budget_halt`) are fsync'd
  to disk before the writer's exclusive lock is released, so a host
  crash after the kernel-side append cannot lose the tail event that
  resume + reconciliation depend on. Informational events
  (`task.started`, `task.budget_reserved`, `task.budget_released`,
  `task.budget_increased_reservation`) skip the fsync by default —
  their state can be reconstructed from the next terminal record. The
  v7.11.0 unconditional-fsync behavior is available as
  `durability: 'always'`; the v7.11.0-CHANGELOG-documented "never
  fsync" baseline is available as `durability: 'never'` for users
  prioritizing throughput over crash safety.
- **Terminal-event constant** — new exported
  `TERMINAL_TASK_EVENT_KINDS` in `src/core/run-state/types.ts`. Adding
  a new terminal task event MUST update this constant; the writer's
  conditional fsync, the run-state replay, and the test snapshot all
  key off it.

- **`budgets.*` schema enumeration + typo warning (issue #210).**
  `presets/schemas/guardrail.config.schema.json` and the runtime
  `GUARDRAIL_CONFIG_SCHEMA` enumerate every known budget key
  (`perRunUSD`, `perPhaseUSD`, `perSubagentUSD`,
  `conservativePhaseReserveUSD`) and tighten `additionalProperties` to
  `false`. Case typos like `perSubAgentUsd` and renamed keys like
  `perSubagentBudget` now FAIL schema validation instead of silently
  disabling the per-subagent cap. The loader also emits a
  `console.warn` BEFORE schema validation that names the offending key
  and suggests the recognized spelling via case-insensitive nearest-key
  match. `cadence doctor` surfaces the same warning prominently — it
  parses `guardrail.config.yaml` independently of the full loader so
  the typo is visible even when the schema rejects the file outright.

### Performance

- The default `'terminal'` durability adds one `fsync` per
  state-transition record — bounded at ~1 per task (start/reserve are
  informational; complete/fail/merge/timeout/budget-halt are terminal).
  Throughput impact at typical concurrency (3 subagents × ~5 terminal
  events each per run) is < 50 ms aggregate on modern SSDs. Users
  willing to trade durability for throughput can opt back into the
  v7.11.0 behavior with `durability: 'never'`.

### Notes

- **No version bump in this PR** — the v8.1.1 patch is named at
  merge-time. The parallel v8.2.0 PR1 (profile schema + resolver)
  ships concurrently and lands in either order.

## Unreleased — v8.1.0 target

### Added

- **4 new direct provider adapters for `reviewEngine`.** All four are
  additive — no breaking changes to existing `auto`, `claude`, `gemini`,
  `codex`, or `openai-compatible` adapters.
  - **`bedrock`** — AWS Bedrock runtime. Default model
    `anthropic.claude-sonnet-4-5-20250929-v1:0` (config-overridable).
    Streaming supported. Auth via standard AWS env vars
    (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_REGION`
    default `us-east-1`, optional `AWS_SESSION_TOKEN` for STS). SDK:
    `@aws-sdk/client-bedrock-runtime` (added as optional dep).
  - **`azure`** — Azure OpenAI. Deployment-routed
    (`{endpoint}/openai/deployments/{deployment}`) with required
    `api-version` query parameter (default `2024-10-21`). Uses `api-key`
    header (Azure convention, not `Authorization: Bearer`). Reuses the
    existing OpenAI SDK — no new dep. Env:
    `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`,
    `AZURE_OPENAI_DEPLOYMENT_NAME`, optional
    `AZURE_OPENAI_API_VERSION`.
  - **`cohere`** — Cohere v2 chat. Default model
    `command-r-plus-08-2024` (config-overridable). Streaming supported
    via `chatStream`. Env: `COHERE_API_KEY`. SDK: `cohere-ai` (added as
    optional dep).
  - **`mistral`** — Mistral La Plateforme. Default model
    `mistral-large-latest`. Streaming supported. Reuses the OpenAI SDK
    with `baseURL: https://api.mistral.ai/v1` — no separate dep. Env:
    `MISTRAL_API_KEY`.
- **Error-mapping parity** across all four new adapters: 401/403 → `auth`
  code, 429 → `rate_limit` code, 5xx / network → `transient_network`
  code (retryable). Uses the shared `classifyError` helper.
- **README "OpenAI-compatible providers" section.** Documents 7 additional
  providers covered by the existing `openai-compatible` adapter
  out-of-the-box, with copy-paste YAML snippets:
  Together AI, Anyscale, Fireworks, OpenRouter, Perplexity, DeepInfra,
  Hyperbolic (in addition to the previously documented Groq and Ollama).
- **68 new tests** (1941 → 2009): per-adapter unit tests with mocked SDK
  boundaries (defaults, env validation, model overrides, streaming
  accumulation, error mapping for 401/403/429/5xx), plus an
  openai-compatible coverage test that verifies every documented
  `baseUrl` parses as a valid HTTPS URL and the adapter accepts each
  config without `invalid_config` errors at parse time.

### Changed

- **`src/adapters/loader.ts`** — registered `bedrock`, `azure`, `cohere`,
  `mistral` as built-in `review-engine` adapter names.
- **`src/adapters/sdk-loader.ts`** — added `loadBedrockRuntime()` and
  `loadCohere()` lazy loaders following the same module-not-found-throws-
  install-hint pattern as the existing Anthropic/OpenAI/Google loaders.

### Notes

- **Total provider count: 16+** — 5 original built-in adapters (`auto`,
  `claude`, `gemini`, `codex`, `openai-compatible`) + 4 new direct
  adapters + 7+ providers documented via `openai-compatible`.
- **No version bump in this PR** — the parallel v8.0.0 rename PR is
  shipping concurrently; version is bumped to 8.1.0 in a follow-up commit
  after both land.
- **No breaking changes** — all changes are additive. Existing configs
  continue to work unchanged.

- v5.6 Phase 7 (docs reconciliation) — pending.

## 8.0.0 — 2026-05-20

**Brand reset — `@delegance/claude-autopilot` is now `@delegance/cadence`,
shipped as `cadence` on the CLI.** Per semver, the npm package name change
is breaking, so this is a major bump. The product itself is identical;
v8.0.0 is a rename and a re-introduction, not a feature release.

### Migration

**Global CLI:**

```bash
# Uninstall BOTH legacy packages first to avoid global-bin collisions
npm uninstall -g @delegance/claude-autopilot @delegance/guardrail
npm install -g @delegance/cadence

# Prefer the new bin name everywhere
cadence brainstorm "..."        # was: claude-autopilot brainstorm "..."
cadence run --base main         # was: claude-autopilot run --base main
```

The legacy `claude-autopilot` and `guardrail` CLI binaries continue to
work as aliases for the entire `v8.x` line. Scripts and CI pipelines that
invoke `claude-autopilot` keep working without changes. Migrate at your
own pace; we will drop the legacy bin no sooner than `v9.0.0`.

**Library / in-process imports (NOT alias-backed):**

If you `import` from the package in code, you must update every import
path now. The bin aliases keep working, but the legacy package's subpath
exports are unreachable from the new package name:

```ts
// before
import { computeFingerprint } from '@delegance/claude-autopilot/run-state/sameness-detector';
import * as concurrent from '@delegance/claude-autopilot/concurrent-dispatch';

// after (v8.0.0)
import { computeFingerprint } from '@delegance/cadence/run-state/sameness-detector';
import * as concurrent from '@delegance/cadence/concurrent-dispatch';
```

The same applies to the default export and the runtime `import('@delegance/cadence')`.

### What changed

- **npm package renamed.** `@delegance/claude-autopilot` → `@delegance/cadence`.
  The old package is `npm deprecate`d (not unpublished) with a redirect
  message. All published `7.x.x` versions remain installable forever under
  the old name.
- **Primary CLI binary renamed.** `cadence` is the canonical bin; the
  package's `bin` map still lists `claude-autopilot` and `guardrail` as
  aliases (functionally identical entrypoints).
- **GitHub repo renamed.** `axledbetter/claude-autopilot` →
  `axledbetter/cadence`. GitHub auto-redirects all old URLs (PRs, issues,
  raw files, clones via HTTPS/SSH) permanently. Update your local
  remotes with `git remote set-url origin https://github.com/axledbetter/cadence.git`
  at your convenience.
- **Welcome banner + error prefixes rebranded.** The CLI now identifies
  itself as `Cadence` (with the legacy name in parentheses for migration
  discoverability). Top-level error messages use `[cadence]` instead of
  `[claude-autopilot]`. The `[guardrail]` legacy prefix continues to be
  banned by `tests/no-legacy-prefix.test.ts`.
- **`@delegance/cadence/run-state/sameness-detector` subpath export
  added.** The legacy `@delegance/claude-autopilot/run-state/sameness-detector`
  path is unreachable from the new package (the old npm name is deprecated)
  but the same module is exposed at the cadence subpath with no API
  changes.
- **Package-root resolver accepts either name.** `findPackageRoot` (used
  by `init`, `migrate-v4`, preset config lookup) walks up looking for a
  `package.json` declaring `@delegance/cadence` OR the legacy
  `@delegance/claude-autopilot`. Existing v7.x consumer trees keep
  working under the helper.
- **Guardrail tombstone (`@delegance/guardrail`) probe order updated
  in-tree.** When forwarding `guardrail` invocations, the new tombstone
  source tries `@delegance/cadence` first and falls back to
  `@delegance/claude-autopilot`. Note: **this change only takes effect
  for users who upgrade `@delegance/guardrail` to a version published
  AFTER v8.0.0**. Users still on the currently-published tombstone
  (which only probes `@delegance/claude-autopilot`) will forward to the
  deprecated old package; npm's deprecation message will then point
  them at `@delegance/cadence`. A republish of the tombstone is the
  cleanest path here and is a follow-up to this ship.

### What did NOT change

- **All env-var names keep the `CLAUDE_AUTOPILOT_` prefix**
  (`CLAUDE_AUTOPILOT_DEPRECATION`, `CLAUDE_AUTOPILOT_TSX`,
  `CLAUDE_AUTOPILOT_STATE_DIR`, `CLAUDE_AUTOPILOT_DEBUG`,
  `CLAUDE_AUTOPILOT_NO_TSX_DEPRECATION`). Renaming them would force
  another breaking change on operators and their CI for zero functional
  payoff. Cadence's `--help` documents them by these existing names.
- **All public skill names** (`brainstorm`, `validate`, `migrate`,
  `bugbot`, `codex-pr-review`, `autopilot`, etc.) are unchanged. Your
  existing `.claude/skills/` overrides keep working.
- **The state directory (`~/.claude-autopilot/`)** is unchanged. No
  migration of cached runs, deprecation stamps, or per-day dedup files
  is required.
- **The library API exported from `src/index.ts`** is unchanged. Code
  that imports `@delegance/cadence` gets the same `runScan`,
  `runValidate`, `detectProject`, etc. signatures it got from the old
  package.

### Risk + review

- Risk: **high** — package rename, GitHub repo rename, npm deprecation
  of the old name. Three sequential Codex passes per the merged
  risk-tiered autopilot policy.
- All 1,941 tests from `v7.11.1` continue to pass.

## 7.11.1 — 2026-05-25

### Added

- **Concurrent multi-PR dispatch default in `skills/autopilot/SKILL.md`.** When the user describes multiple independent deliverables in one invocation, the autopilot skill now instructs dispatch as parallel Agent subagent invocations (each in its own worktree-isolated branch). Only serializes on explicit user request or genuine cross-PR dependency. Previously this default was only documented in operator-side overrides.

## 7.11.0 — 2026-05-20

**v7.11.0 — Concurrent subagent dispatch (GA).** This release closes the
v7.11.0 stack landed as `v7.11.0-pre.1` through `v7.11.0-pre.5` and ships
the user-facing skill + schema + release wiring. The implementation was
split into six PRs for reviewability (see PR links below); the published
version users install is `7.11.0` on npm `latest`. The five `pre.*` tags
remain in git history as the implementation breakdown.

Spec: [PR #187](https://github.com/axledbetter/claude-autopilot/pull/187)
([`docs/superpowers/specs/2026-05-19-v7.11.0-concurrent-subagent-execution-design.md`](docs/superpowers/specs/2026-05-19-v7.11.0-concurrent-subagent-execution-design.md)).

Implementation PRs:
- [#197](https://github.com/axledbetter/claude-autopilot/pull/197) — dep graph foundations (`v7.11.0-pre.1`).
- [#198](https://github.com/axledbetter/claude-autopilot/pull/198) — locking primitives (`v7.11.0-pre.2`).
- [#199](https://github.com/axledbetter/claude-autopilot/pull/199) — event + budget atomicity (`v7.11.0-pre.3`).
- [#200](https://github.com/axledbetter/claude-autopilot/pull/200) — scheduler + worktree lifecycle (`v7.11.0-pre.4`).
- [#201](https://github.com/axledbetter/claude-autopilot/pull/201) — merge orchestrator (`v7.11.0-pre.5`).
- This PR (#193) — SKILL integration + release wiring.

### Added

- **Concurrent subagent dispatch in autopilot Step 3.** The sequential
  one-task-at-a-time loop is replaced with a tier-based scheduler that
  dispatches independent plan tasks in parallel into isolated per-task
  worktrees under `.claude/worktrees/<run-ulid>/<task-id>/`. A dedicated
  integration worktree at `.claude/worktrees/<run-ulid>/integration/` owns
  the only checkout of `feature/<topic-slug>`; the main repo working tree
  is never touched for the duration of the run.
- **`depends_on:` annotation in plan files** (documented in
  `skills/writing-plans/SKILL.md`). Tasks declare dependencies by `### Task
  N: <name>` reference; the scheduler builds a DAG, detects cycles, and
  topologically sorts tasks into dispatchable tiers. Multi-commit task
  branches are cherry-picked in `git rev-list --reverse base..tip` order,
  producing a linear feature-branch history.
- **`concurrency:` config block in `guardrail.config.yaml`** (schema:
  `presets/schemas/guardrail.config.schema.json`). New keys:
  - `maxParallelSubagents` (int, **range 1..8**, default 3) — invalid
    values fail at config-load with a schema validation error.
  - `perSubagentTimeoutMs` (int ms, default 30 minutes).
  - `assumeIndependentWithoutDependsOn` (bool, default false).
  - `useDedicatedMergeWorktree` (bool, default true).
  - `allowMergeCommitsInTasks` (bool, default false).
- **`budgets.perSubagentUSD`** — HARD cost cap per subagent. Dispatch is
  rejected when `preFlightEstimate > perSubagentUSD`; an in-flight
  subagent is SIGTERMed (process group; SIGKILL after 30s) and emits
  `task.failed` if actual cost exceeds the cap mid-execution. Set to
  `null` to disable.
- **11 new run-state event types** for concurrent dispatch:
  `task.started`, `task.budget_reserved`,
  `task.budget_increased_reservation`, `task.budget_released`,
  `task.completed`, `task.failed`, `task.merged`,
  `task.merge_conflict`, `task.merge_aborted`, `task.timeout`,
  `task.budget_halt`. All event writes route through a per-run serialized
  writer that holds an exclusive `flock` on `events.ndjson` for the
  `(replay → check → append → release)` critical section. **The
  append is a single `O_APPEND` write (atomic at the byte level) but
  is NOT followed by `fsync` per event** — see "Audit-log durability"
  below for the rationale and the no-fsync limitation.
- **Cross-process repo lock** at `.claude/run-state/repo.lock`, acquired
  by every CLI command that mutates repo state (autopilot, run resume,
  runs gc, runs cleanup). Uses `flock(LOCK_EX|LOCK_NB)` — NOT
  check-then-create. Stale-lock detection (PID not running on host AND
  acquired > 1 hour ago) surfaces an explicit
  `claude-autopilot runs cleanup --force-unlock` recovery command — no
  auto-clear.
- **In-process git operation queue** serializing all repo-level git
  operations (worktree add/remove, branch create/delete, cherry-pick,
  abort, GC) so concurrent scheduler callers cannot corrupt
  `.git/refs/` or pack files.
- **Public package subpath export** `./concurrent-dispatch` — consumers
  can `import { runScheduler, computeEffectiveConcurrency }` from
  `@delegance/claude-autopilot/concurrent-dispatch` without deep-importing
  into compiled paths.
- **Skill integration:** `skills/autopilot/SKILL.md` Step 2 now creates
  `feature/<topic-slug>` as a ref-only (no checkout in main worktree),
  and Step 3 invokes the concurrent dispatcher with the fallback rule
  enforced by `src/core/concurrent-dispatch/dep-graph.ts`. New skill
  `skills/writing-plans/SKILL.md` documents the `depends_on:` annotation,
  the three-clause fallback policy, and walks through a mixed
  annotated/unannotated plan example.

### Changed — new failure modes (operator-visible)

These are **new behaviors v7.10.0 did not have**. Read carefully before
upgrading:

- **Cherry-pick conflict halts the run.** The merge orchestrator does NOT
  auto-resolve, even for trivial conflicts. Diagnostics
  (`git diff --name-only --diff-filter=U`, `git ls-files -u`, full
  porcelain) are persisted to
  `.claude/run-state/<run-ulid>/conflicts/<task-id>.md` BEFORE
  `cherry-pick --abort` clears the working tree. The user resolves by
  (a) adding an explicit `depends_on:` to the plan and rerunning,
  (b) manually resolving in the preserved worktree, or
  (c) marking the offending pair as sequential in
  `guardrail.config.yaml`.
- **Interrupted tasks require explicit confirmation on resume.** A task
  in state `started` with NO terminal event (no `task.completed`,
  `task.failed`, `task.timeout`) is classified `interrupted` by
  `claude-autopilot run resume <ulid>`. The CLI refuses to auto-merge
  any partial commits — the user must pass
  `--confirm-interrupted-tasks <task-id>...` to either re-dispatch from
  a clean branch (discarding partial commits) or merge what's there
  (user accepts risk). This is stricter than the pass-1 draft, which
  would have auto-merged "if commits present" — that was unsafe because
  commits alone do not prove the subagent finished its task contract.
- **`budgets.perSubagentUSD` is a HARD cap, not soft.** Dispatch is
  rejected pre-flight if the estimate exceeds the cap, and a running
  subagent is killed (SIGTERM → SIGKILL of its process group) if actual
  cost overruns. To get soft-reservation semantics, omit
  `perSubagentUSD` and rely solely on `perRunUSD`.
- **Task branches with merge commits are rejected by default.** Set
  `concurrency.allowMergeCommitsInTasks: true` if your subagents
  legitimately produce merge commits.
- **Audit-log durability — documented limitation.** Event writes are
  single-`write(O_APPEND)` per JSONL line under the exclusive `flock`,
  but the writer does NOT `fsync(events.ndjson)` per event. A power
  loss between two appends can therefore lose the last few events even
  though the file lock was held atomically. This is a deliberate
  trade-off: per-event fsync would dominate scheduler throughput at
  high concurrency. If your environment requires per-event durability,
  set `maxParallelSubagents: 1` and the audit-log will degrade to
  v7.10.0 semantics.

### Fallback policy (backwards compatibility)

Plans without `depends_on:` annotations continue to work without changes:

- `concurrency.maxParallelSubagents: 1` → sequential dispatch
  reproducing v7.10.0 behavior exactly.
- ZERO tasks declare `depends_on:` → sequential by default. Existing
  plans are NEVER silently parallelized. Override with
  `concurrency.assumeIndependentWithoutDependsOn: true` to opt in to
  file-overlap inference.
- At least one task declares `depends_on:` → explicit deps + file-
  overlap inference for the remaining unannotated tasks.

Cycle detection runs in all three cases before dispatch begins.

### Resume semantics

`claude-autopilot run resume <ulid>` classifies tasks by their LAST
terminal event in `events.ndjson`:

- `task.merged` → DONE; skip.
- `task.completed` (no merged) → eligible; re-run merge orchestrator if
  deps are merged.
- `task.failed` → terminal; surface, do not retry without intervention.
- `task.merge_conflict` → terminal; surface report path; user must
  resolve before resume continues.
- `task.timeout` → terminal (dual emission of `task.timeout` +
  `task.failed`).
- `task.started` with no terminal event → INTERRUPTED; requires
  `--confirm-interrupted-tasks <task-id>...`.

### Out of scope (deferred, per spec)

- Hosted profile sharing — separate spec.
- AI-generated custom config — separate spec.
- v6 run-state engine integration into the autopilot skill — issue #180.
- Frontend quality — issue #178.
- Expand/contract migration safety — issue #179.
- Parallelizing validate / codex-review / bugbot steps — separate spec.
- Distributed execution across machines — separate spec.

## 7.10.1 — 2026-05-13

**v7.10.1 — `examples` verb.** Patch release. Closes the discoverability
gap a new user hits between `setup` and `scaffold --from-spec`: the
new `claude-autopilot examples` verb prints sample specs for each
supported stack (node / python / fastapi / go / rust) so an operator
can pipe one to a file and feed it back into the scaffolder.

**New:** `claude-autopilot examples` lists all five stacks with a
5-line preview. `claude-autopilot examples <stack>` prints the full
spec for one stack to stdout — pipe-friendly:

```bash
claude-autopilot examples fastapi > docs/specs/my-api.md
# edit the spec...
claude-autopilot scaffold --from-spec docs/specs/my-api.md
```

**Bundled examples.** Five spec markdown files ship in
`examples/specs/{node-cli,python-cli,fastapi,go-cli,rust-cli}.md` —
one per supported scaffold target. Each shows the `## Files` section
shape the scaffolder reads, plus a `## Goal` and `## How to use`
section for human readers.

**Package shape.** `examples/` is added to the published `files:`
array in package.json so the directory ships in the npm tarball — the
verb resolves spec paths via `findPackageRoot` and works under both
source and globally installed CLI invocations.

## 7.10.0 — 2026-05-13

### Added
- **Retry-loop sameness detector** (`src/core/run-state/sameness-detector.ts`) — new pure-TS module exporting `computeFingerprint`, `isSameFailure`, `shouldEscalate`, and `stripVolatileTokens`. A failure fingerprint is `{ phase, errorType, errorLocation, errorMessage, hash }` where `hash` is `sha256(JSON.stringify([phase, errorType, errorLocation, normalize(message[:200])]))`. JSON encoding is delimiter-safe — pipes, quotes, and embedded JSON in fields cannot produce cross-tuple collisions. `shouldEscalate(history)` returns `{ escalate: true }` when the last two entries have identical hashes — the signal that retries are making no progress.
- **Volatile-token stripping built into the detector.** Both `errorLocation` and `errorMessage` are scrubbed of UUIDs, ISO timestamps, 13-digit epoch ms, sha1/sha256 hex digests, /tmp + /var/folders paths, and localhost:port before hashing — so a retry whose message differs only in a per-run UUID or temp directory still hashes to the same fingerprint. Exported as `stripVolatileTokens()` for callers that want to scrub before constructing a fingerprint.
- **Public package subpath export.** `package.json` adds `./run-state/sameness-detector` pointing at `dist/src/core/run-state/sameness-detector.{js,d.ts}` so consumers can `import { computeFingerprint, shouldEscalate } from '@delegance/claude-autopilot/run-state/sameness-detector'` without deep-importing into compiled paths.
- **Pipeline halts when retries make no progress, even if you have retries remaining.** `skills/autopilot/SKILL.md` Step 4 (validate), Step 7 (Codex PR review), and Step 8 (bugbot) now consult the detector before consuming a retry. If the same failure fingerprint fires twice in a row inside any retry loop, the pipeline stops and surfaces the matching fingerprint to the user instead of burning the remaining retry budget. This catches the class of bug where validate retries fix nothing because the underlying type error is unreachable from the change set.
- Tests: `tests/run-state/sameness-detector.test.ts` (32 cases) covers the three issue-#181 acceptance scenarios (same × 2 escalates, same × 1 continues, different × 3 continues), edge cases (empty history, ABA pattern, message truncation, all three phases), delimiter-safety (fields containing `|`), and volatile-token scrubbing (UUIDs, timestamps, tmpdirs). `tests/run-state/sameness-detector-integration.test.ts` (7 cases) verifies SKILL.md retry-block references and that the compiled subpath export is importable + functional.

### Notes
- Persistence is intentionally in-memory only in v7.10.0. Per-retry-loop history is held in the autopilot skill execution scope; bugbot and validate do not share a history. The v6 run-state events.ndjson integration is tracked separately as issue #180.
- Released as v7.10.0 even though issue #181 was originally labeled v7.11.0 — this ships before #178 and #179, so it gets the next minor.

### Out of scope (still pending)
- Expand/contract migration classification (additive vs destructive enforcement) — v7.11.0 candidate
- v6 run-state engine integration into the autopilot skill (4,873 LOC of checkpoint/resume infra currently unused by the skill) — issue #180

## 7.9.1 — 2026-05-13 (correctness hotfix)

### Fixed
- **`skills/autopilot/SKILL.md` ran migrate BEFORE validate.** On stacks that auto-promote (Supabase-script-specific), this could leave production with new schema and no working code if validate or PR review later failed. Resequenced: validate is now Step 4, migrate-dev is Step 5. PR + Codex + bugbot follow. Production migration is explicitly handed off to the user's CI/CD pipeline.
- **Removed misleading "dev → QA → prod auto-promote" claim.** That behavior is Supabase-stack-specific, not a generic CLI capability. The skill now references the four real `migrate.policy` keys (`allow_prod_in_ci`, `require_clean_git`, `require_manual_approval`, `require_dry_run_first`) and explains how to wire them in `.autopilot/stack.md`.

### Out of scope (filed as v7.10.0 + v7.11.0 candidates)
- Expand/contract migration classification (additive vs destructive enforcement)
- v6 run-state engine integration into the autopilot skill (4,873 LOC of checkpoint/resume infra currently unused by the skill)
- Retry-loop sameness detector ("same fingerprint twice → escalate to human")

## 7.9.0 — 2026-05-12

### Changed
- `skills/autopilot/SKILL.md` rewrite: merge "idea → spec" Step 0 (Step 0 brainstorming with per-step Codex validation) with the risk-tiered codex pass policy from v7.8.0. Adds entry decision tree (idea vs spec), operational preflight (gh auth + push-permission check, strict worktree-clean gate, Codex CLI resolution with package-fallback, portable test-runner detection), tightened CRITICAL-finding remediation semantics ("must remediate, not just acknowledge"), missing-`risk:` frontmatter backward-compat (default medium + keyword auto-escalation to high, resolved at preflight not mid-pipeline), entry-path-aware risk-tier pass counts (idea-entry vs approved-spec-entry), and `mkdtemp`-based secure tempfile handling (0700 dir + 0600 file + cleanup in finally) to replace the predictable timestamp/pid pattern. Net 242→292 lines.

### Documentation
- Each pipeline step now states its risk-tier behavior explicitly; Step 0 brainstorming substeps use 1 codex pass each, Step 1 onward uses the risk-tiered policy.

No CLI/code changes. Skill content only.

## 7.8.0 — 2026-05-11

### Changed
- `tsx` resolution now prefers project-local installation, then `tsx` on
  `$PATH`, then the bundled copy. The bundled `tsx` is scheduled for removal
  in v8.0.0 — a once-per-day deprecation warning surfaces when falling back
  to the bundled copy. Silence with `CLAUDE_AUTOPILOT_NO_TSX_DEPRECATION=1`.
  Override resolution source with `CLAUDE_AUTOPILOT_TSX=bundled|project|path`
  or the new `--tsx-source` CLI flag.
- `@supabase/supabase-js` is now lazy-loaded only when invoking
  `claude-autopilot dashboard upload`. Moved from `dependencies` to
  `optionalDependencies` — default install footprint is unchanged in npm 10
  (which installs optional deps), but `npm install --omit=optional` now
  works for local-only usage. A new `omit-optional-smoke.yml` CI workflow
  exercises this install path on every PR. **The `--omit=optional` guarantee
  is verified for npm only**; pnpm/yarn behavior is best-effort and not
  gated in CI for v7.8.0 (per spec amendment A8).

### Removed (from published tarball)
- `tests/snapshots/`, `scripts/snapshots/`, `scripts/autoregress.ts` —
  dev-only. The `autoregress` CLI verb continues to work from the repo
  itself, but the snapshot fixtures are no longer shipped to npm consumers.

Published tarball file count drops by ~15 files (the snapshot fixtures and
the autoregress harness); runtime behavior is unchanged for default local-only
usage except for the bundled `tsx` deprecation warning.

### Added
- `--tsx-source <bundled|project|path>` CLI flag and `CLAUDE_AUTOPILOT_TSX`
  env var for explicit resolution overrides (escape-hatch for users whose
  project-local tsx is broken / incompatible).
- `CLAUDE_AUTOPILOT_NO_TSX_DEPRECATION=1` env opt-out for the deprecation
  warning (CI / log-hygiene).
- `XDG_STATE_HOME` + `CLAUDE_AUTOPILOT_STATE_DIR` support for the warning
  dedup state file (defaults to `~/.claude-autopilot/`).
- `scripts/audit-supabase-imports.ts` — AST-based audit (TypeScript compiler
  API) that fails CI if a static value-import of `@supabase/supabase-js`
  appears outside `src/cli/dashboard/**`. Runs via `npm run audit:supabase`.
- `.github/workflows/omit-optional-smoke.yml` — install-and-probe smoke
  test for the `npm install --omit=optional` install path.
- `src/cli/tsx-resolver.ts` + `src/cli/dashboard/missing-package.ts` (new
  modules, fully unit-tested — see `tests/cli/tsx-resolver.test.ts`,
  `tests/cli/dashboard/missing-package.test.ts`, and
  `tests/cli/tsx-source-flag.test.ts`).

### Spec
- `docs/specs/v7.8.0-decouple-runtime-deps.md` — full spec with two folded
  codex reviews (pass-1 portability + escape hatch; pass-2 amendments
  A1-A8 covering ESM/CJS safety, CLI parser scope, PATH self-pointer,
  AST audit, type-only imports, hand-rolled PATH lookup dropping the
  `which` dep, XDG state dir, npm-only --omit=optional documentation).
## 7.7.0 (2026-05-11)

**v7.7.0 — Rust scaffold support.** Minor release. Promotes Rust from
"detected-but-unsupported" (exit 3 in v7.4–v7.6) to a first-class
scaffold target, matching the Node + Python + FastAPI + Go shape.

**New:** `claude-autopilot scaffold --from-spec <spec.md> --stack rust`
(or auto-detected when the spec's `## Files` section lists `Cargo.toml`,
`src/main.rs`, or `src/lib.rs`).

**Lib-vs-bin fork.** Rust adds a fork the Go scaffolder doesn't need:

- spec lists ONLY `src/lib.rs` (no main.rs) → **library crate**
  (`src/lib.rs` with a public `hello()` + inline `#[cfg(test)] mod tests`,
  Cargo.lock added to `.gitignore`)
- spec lists `src/main.rs` (with or without lib.rs) → **binary crate**
  (`src/main.rs` with `println!` + `tests/integration_test.rs` smoke
  test, Cargo.lock NOT in `.gitignore`)
- spec lists BOTH → **mixed mode** (both targets generated; Cargo.lock
  excluded since the binary target wins per Cargo's documented convention)
- spec hints neither → defaults to binary (matches `cargo init` default)

**Cargo.lock heuristic.** Library-only crates omit `Cargo.lock` from the
commit per Cargo docs; binary + mixed crates commit it. The Rust
scaffolder's `.gitignore` augmentation reflects this — `target/` is
always added; `Cargo.lock` is added only when the spec resolves to
library-only.

**Crate name normalization.** Cargo identifiers are `[a-z0-9_]` only and
must not start with a digit. The scaffolder lowercases `basename(cwd)`,
replaces any non-allowed char with `_`, collapses underscore runs, and
prefixes `_` when the result starts with a digit. Examples: `my-pkg-2`
→ `my_pkg_2`, `2cool` → `_2cool`, `My App` → `my_app`, `foo.bar` →
`foo_bar`.

**Never overwrites.** `Cargo.toml`, `src/main.rs`, `src/lib.rs`, and
`tests/integration_test.rs` are preserved if they already exist — matches
the Go + Python scaffolder pattern.

**Polyglot detection.** `detectStack()` now includes Rust signals
(`Cargo.toml` / `src/main.rs` / `src/lib.rs`) in the polyglot count. So
e.g. `package.json` + `Cargo.toml` together correctly fail-loud with
`polyglot spec — pass --stack to disambiguate` instead of silently
picking one.

**`--list-stacks`** now shows Rust under Supported and drops it from
Recognized-but-unsupported. Ruby remains the lone detection-only stack
(would detect via `Gemfile`).

## 7.6.0 (2026-05-10)

**v7.6.0 — Go scaffold support.** Minor release. Promotes Go from
"detected-but-unsupported" (exit 3 in v7.4/v7.5) to a first-class
scaffold target, matching the Node + Python + FastAPI shape.

**New:** `claude-autopilot scaffold --from-spec <spec.md> --stack go`
(or auto-detected when the spec's `## Files` section lists `go.mod`
or `main.go`).

Generates for a basic spec:

- `go.mod` — `module <basename(cwd)>` + `go 1.22`, with an inline
  comment documenting that the module path is the local-scaffold
  default and should be replaced with the full hosted path
  (e.g. `github.com/<user>/<name>`) before publishing.
- `main.go` — `package main` + Hello world (skipped when the spec
  uses a `cmd/<name>/main.go` layout).
- `main_test.go` — `TestSmoke` stub for table-driven tests.
- `.gitignore` — idempotent augmentation: appends `vendor/`,
  `*.exe`, `*.test` if not already present.

**Name normalization.** `basename(cwd)` lowercased, whitespace
collapsed to `-`. Dots + hyphens preserved (valid Go module path
chars). Path-invalid characters (`/`, `\`, control bytes) reject
with a clear error.

**Never overwrites.** `go.mod`, `main.go`, `main_test.go`, and
existing `.gitignore` entries are preserved — matches the Python
scaffolder pattern.

**Polyglot detection (codex CRITICAL pass-1).** `detectStack()` now
scans `## Files` for ALL supported stack signals (Node, Python, Go)
and exits 3 with `polyglot spec — pass --stack to disambiguate` when
more than one supported stack is present. Previously the check was
Node-vs-Python only; v7.6 closes the gap so e.g. `package.json` +
`go.mod` together correctly fail-loud instead of silently picking one.

**`--list-stacks`** now shows Go under Supported and drops it from
Recognized-but-unsupported. Rust + Ruby remain detection-only; the
Rust scaffolder is deferred to **v7.7.0** (out of scope here).

**Rust deferred.** `Cargo.toml` still exits 3 ("rust detected but
not supported until v7.7"). Targeted for v7.7.0 alongside the same
shape (Cargo.toml + `src/main.rs` + a smoke test).

## 7.5.0 (2026-05-10)

**v7.5.0 — route-sensitivity-tiered membership revocation.** Minor
release. Closes W4 from the v7.4.1 codex strategic review without
adding infrastructure (Redis / Realtime / KV all rejected — see
`docs/specs/v7.5.0-route-sensitivity.md` for the trade-off analysis).

**Problem.** v7.0 Phase 6 caches `check_membership_status` for 60s
in an HMAC-signed cookie. Worst-case revocation window = 60s for
EVERY dashboard request, including admin-class mutations and
sensitive reads where ≤1-request revocation is the bar.

**Solution.** Split the policy by route sensitivity instead of
tightening globally:

| Tier | Revocation window | Behavior |
|---|---|---|
| LOW (default) | ≤60s | v7.0 cookie cache (no change) |
| HIGH (mutations + sensitive reads) | ≤1 request | Skip cookie, always RPC |

HIGH list (locked in code, codex-reviewed): mutations on any
`/api/dashboard/*` route + GETs under
`/api/dashboard/orgs/:id/{audit,cost,cost.csv,sso/**,members/**,billing/**}`
+ all `/api/dashboard/api-keys/*` (including GET — codex pass-2 W4
flagged the listing as sensitive).

**Defense in depth (codex pass-2 CRITICAL #3).** Middleware regex
matching is brittle — a new sensitive handler that's not yet in
`HIGH_SENSITIVITY_PATTERNS` would default to LOW. Mitigation: every
high-sensitivity route handler now calls
`assertActiveMembershipForOrg()` at the top as the inner correctness
gate. Middleware is the outer optimization (skips the cookie cache);
the handler call is the inner gate (doesn't depend on the regex
list staying in sync).

**Path-vs-active-org assertion (codex pass-2 CRITICAL #2).** For
high-sensitivity org-scoped routes the middleware also extracts
`:orgId` from the request path and asserts it matches the
`cao_active_org` cookie. A user active in Org A reaching an Org B
URL gets a 403/302 immediately — defense against a sloppy
downstream handler.

**New files:**

- `apps/web/lib/middleware/route-sensitivity.ts` (~85 LOC) —
  `HIGH_SENSITIVITY_PATTERNS` + `isHighSensitivityRoute()`.
- `apps/web/lib/dashboard/assert-active-membership-for-org.ts`
  (~165 LOC) — defense-in-depth helper + `respondToMembershipError()`
  response builder.
- `apps/web/__tests__/middleware/route-sensitivity.test.ts` (24
  cases — spec list of 7 + non-GET coverage + boundary regex tests
  for codex pass-2 W4/W5).
- `apps/web/__tests__/middleware/revocation-integration.test.ts`
  (8 cases — disabled-with-fresh-cookie + low-tier cache-still-wins
  + helper error-mapping integration).
- `apps/web/__tests__/lib/dashboard/assert-active-membership-for-org.test.ts`
  (16 cases — 4 error codes + happy path + UUID validation +
  respondToMembershipError variants).

**Modified files:**

- `apps/web/middleware.ts` — sensitivity branch BEFORE cookie verify;
  parseOrgIdFromPath check on high-sensitivity routes; skip cookie
  mint on high-sensitivity success.
- 10 route handlers wired with `assertActiveMembershipForOrg()` as
  the first authorization step (members CRUD + invite + enable +
  disable; org PATCH; audit; cost JSON + CSV; SSO disconnect +
  required + setup + domains + verify).

**Test regressions promoted to v7.5.0 expectations:** 8 existing
tests that asserted the OLD pre-helper behavior (non-member → 404
via RPC's `not_admin`, disabled-user → `not_owner`/`not_admin`) now
assert the NEW uniform helper behavior (non-member → 403
`no_membership`; disabled-user → 403 `member_disabled`). Status
codes unchanged for the disabled-user cases; status code for
non-member shifted from 404 → 403 with a non-enumerating body code.
Comments inline in each updated test point at this v7.5.0 trade-off.

**Test count:** 621 → 669 (+48 web). CLI suite unchanged at 1606
(no CLI changes).

**Codex traceability:**

| Finding | Resolution |
|---|---|
| Pass-1 C1 (W4 not closed) | Reframed: route-tier closes the security/compliance subset of W4. |
| Pass-1 C2 (Vercel/ECS confusion) | False positive — explicit deployment-context section in spec. |
| Pass-1 W1 (Redis ROI) | False positive — autopilot.dev has no Redis. |
| Pass-1 W3 (route-sensitivity split) | **Adopted as the central design.** |
| Pass-2 CRITICAL #2 (path-vs-activeOrg) | `parseOrgIdFromPath` + middleware assertion. |
| Pass-2 CRITICAL #3 (regex bypass risk) | `assertActiveMembershipForOrg()` defense-in-depth helper called at top of every HIGH handler. |
| Pass-2 W4 (api-keys GET sensitivity) | `/api/dashboard/api-keys/*` (including GET) added to HIGH list. |
| Pass-2 W5 (boundary pattern correctness) | Anchored regex with explicit `/`/`$` terminator; tests cover `/costume`, `/auditor`, trailing-slash, nested-path. |

**Out of scope.** Vercel KV / Realtime websocket (deferred), JWT-
side revocation (v7.1 already collapses ingest to ≤1 request),
configurable sensitivity classification (locked in code on purpose),
wrapper `withActiveMembershipRequired()` decorator (deferred to
v7.6+ refactor; the explicit call is sufficient for v7.5.0).

## 7.4.3 (2026-05-11)

**v7.4.3 — FastAPI scaffold respects spec-derived package name.**
Patch release. Real-package end-to-end test on v7.4.2 surfaced
this regression: the v7.4.0 Python/FastAPI scaffolder always used
`basename(cwd)` for the package directory and ignored spec-listed
`src/<pkg>/main.py` paths. Result: scaffolding a spec that listed
`src/fastapi_test/main.py` from a directory called `v742-fastapi`
produced TWO competing trees:

* `src/v742_fastapi/` — auto-generated FastAPI app (correct
  content, wrong location)
* `src/fastapi_test/main.py` — empty placeholder from the spec's
  bullet (right location, no content)

`pyproject.toml`'s `[project.scripts]` pointed at the
auto-generated tree (`v742_fastapi.main:run`) — the spec's intent
was clearly the named package.

**Fix:** new `packageNameFromSpec(parsed)` extracts the package
name from the first `src/<pkg>/<*>.py` entry in the spec's
`## Files` section. Falls back to the cwd-derived default only
when the spec doesn't list any `src/<pkg>/` path.

8 new tests in `tests/scaffold-python.test.ts` cover:
* extraction from `src/<pkg>/main.py` (the conventional case)
* extraction from `src/<pkg>/<other>.py`
* null when no `src/<pkg>/<*>.py` listed
* null for non-`src/` paths
* first-match-wins on multiple `src/<pkg>/` entries
* rejects invalid Python identifier characters in the path
* the exact regression case (`src/fastapi_test/main.py` from
  cwd `v742-fastapi`)
* fallback to cwd basename when spec has no `src/<pkg>/`

Plus 2 end-to-end tests verifying:
* scaffold from `cwd=v742-real` + `src/intentional_pkg/main.py`
  spec → SINGLE `src/intentional_pkg/` directory (no competing
  tree); `pyproject.toml` consistent throughout
* scaffold from `cwd=myapp` + spec without `src/<pkg>/` → still
  uses `src/myapp/` (preserves v7.4.0 default behavior)

1597 → 1606 CLI tests (+9). tsc clean. build clean.

## 7.4.2 (2026-05-11)

**v7.4.2 — risk-tiered codex pass policy in autopilot skill.**
Docs-only PR. Codifies finding N2 from the v7.4.1 codex strategic
review into `skills/autopilot/SKILL.md`.

**New policy table** in the skill:

| Spec risk | # of codex passes |
|---|---|
| **Low** (CLI UX, doc-only, scaffolding, CI tweaks) | 1 |
| **Medium** (new exec modes, auth, billing, data-access, env vars, API contracts) | 2 |
| **High** (sandboxing, multi-tenancy, auto-merge, repo-mutation, secrets, RPC/SECURITY DEFINER) | 3 + external review |

**Convention:** spec docs declare `risk: low | medium | high` in
frontmatter. Omitted defaults to **medium** (safer than defaulting
to low).

**v7.x examples** included in the skill text:
* v7.1.7 (low) — 1 pass, 0 CRITICALs in practice.
* v7.4.0 (low) — 1 pass, 2 CRITICALs caught pre-impl.
* v7.0 Phase 6 (high) — 3 passes, would have shipped credential-
  exfiltration vector C3 without all three.
* v8.0 spec (high) — 2 passes done, needs 3rd before v8 alpha.

No code change. Bumping to 7.4.2.

## 7.4.1 (2026-05-11)

**v7.4.1 — strategic pivot doc from codex 5.5 review.** Docs-only
PR. Records the decision to pause v8 daemon implementation pending
customer discovery, plus 8 other findings from the codex strategic
review of full project state on 2026-05-11.

**Key outcome:** "ship v8 daemon" is NOT the next milestone. The CLI
chat-session loop is the validated asset; v8 is unvalidated. New
priority order: (1) customer discovery sprint, (2) hosted beta
readiness slice (operational), (3) org-tier revocation completion,
(4) risk-tiered codex pass policy in the autopilot skill.

**Process changes adopted:**

* **Risk-tiered codex passes** (1 for low-risk CLI UX, 2 for new
  exec/auth/billing/data-access modes, 3 for sandboxing /
  multi-tenancy / repo-mutation).
* **Strategic codex review every ~10 PRs** (separate from per-spec
  passes — catches "ship more without validating demand" trap).
* **Bounded benchmark suite gate** (4 repo shapes only, run
  pre-release + after major workflow changes — already in v8 spec).

**v8 IF customer discovery validates demand:** local-only alpha
first (per W5 of codex review). NO hosted workers, NO billing, NO
auto-merge until alpha demand is proven.

Full doc at `docs/strategy/2026-05-11-codex-pivot.md`.

## 7.4.0 (2026-05-11)

**v7.4.0 — scaffold per-stack support (Python + FastAPI).** Closes
the v7.1.6/v7.1.8 benchmark caveat ("n=1, Node 22 ESM only —
Python/Rust/Go remain v8 follow-ups") and gates v8 spec
stabilization criteria #2 (4-repo benchmark suite).

* **Stack detection precedence** (codex C1): explicit `--stack` >
  FastAPI > Python > Node > detected-but-unsupported > Node fallback.
  FastAPI checked BEFORE Python so FastAPI specs that include
  `pyproject.toml` aren't mis-classified.
* **FastAPI scaffold completeness** (codex C2): generates a runnable
  `src/<package>/main.py` with `app = FastAPI()`, `/health` route,
  `run()` function, plus `tests/test_main.py` (otherwise the
  `[project.scripts]` entry was dangling).
* **Name normalization** (codex W1): PEP 503 distribution name +
  valid Python identifier package name. `my-pkg-2` → distribution
  `my-pkg-2`, package `my_pkg_2`. Hatchling explicit `packages`
  config always present.
* **Detected-but-unsupported** (codex W2): Go/Rust/Ruby specs →
  exit 3 with diagnostic, NOT silent fallback to Node.
* **Polyglot guard** (codex W3): specs listing both `package.json`
  AND `pyproject.toml` without `--stack` → exit 3.
* **Narrow dep extraction** (codex W6): 3 patterns only, no inferred
  versions, dedup by PEP 503 normalized name. FastAPI auto-includes
  `fastapi>=0.110` + `uvicorn[standard]>=0.27`.
* **Module split**: `scaffold.ts` is now the dispatcher;
  per-stack scaffolders live under
  `src/cli/scaffold/{node,python,types}.ts`.
* **New flags**: `--stack <node|python|fastapi>`, `--list-stacks`.
* **Integration test** (codex N3): scaffolds FastAPI + creates
  isolated venv (handles PEP 668) + `pip install -e .` + import-
  app. Skipped cleanly when `python3` unavailable.

1563 → 1597 CLI tests; tsc clean; build clean. PR #155 spec +
#156 impl. Version 7.3.0 → 7.4.0.

## 7.3.0 (2026-05-10)

**v7.3.0 — library export surface for v8 daemon.** Minor bump
(new public API surface). The v8 daemon spec needs to call into
the autopilot pipeline without spawning the CLI as a subprocess
— subprocess boundaries lose error context, double up dependency
resolution, and make sandbox enforcement harder. This PR exposes
a curated set of `run*` functions as a stable library API.

**New exports** at `@delegance/claude-autopilot`:

* Pipeline read-only / discovery: `runScan`, `runScaffold`,
  `runValidate`, `runFix`, `runCosts`, `runReport`, `runDoctor`,
  `runSetup`.
* Pipeline side-effecting: `runDeploy`, `runDeployStatus`,
  `runDeployRollback` (daemon callers must wrap in policy gates
  per v8 spec C3).
* Helpers: `detectProject`.
* Types: `DetectionResult`, `ScaffoldOptions`, `ScaffoldResult`,
  `SetupOptions`, `ProfileName`.

**Stability contract** documented in `docs/library-api.md`. Anything
in that doc is SemVer-stable; deep imports
(`@delegance/claude-autopilot/dist/...`) are unsupported.

**`package.json` `exports` map** gains a `default` entry pointing
at `./dist/src/index.js` so consumers can
`import { runScaffold } from '@delegance/claude-autopilot'`
instead of deep-importing.

**Deliberate non-exports** (still callable via deep imports, no
guarantee): JSON-envelope wrappers, internal `_*` helpers, the
`runs` engine-introspection group (separate v8 prerequisite).

4 new tests verify (a) all declared exports resolve at runtime,
(b) `detectProject` returns the documented shape on the autopilot
repo itself, (c) `package.json` `exports` map shape is locked.
1559 → 1563 CLI tests; tsc clean; build clean.

Version 7.2.1 → 7.3.0 (minor bump for new library surface).

## 7.2.1 (2026-05-10)

**v7.2.1 — v8 spec codex pass-2 amendment.** Docs-only PR. Folds
the codex pass on the merged v8 spec (PR #152) into a new
"Codex pass 2 amendment" section. 3 CRITICAL + 6 WARNING + 1 NOTE
all surfaced real productization gaps; all locked into the spec
rather than left as open questions.

**Key trust-model decisions now locked in the spec** (were
open-questions before):

* **C1 — Policy pinning.** `.autopilot/policy.yaml` loaded only from
  default branch at run-start SHA; frozen for the run; daemon's own
  PRs cannot mutate active permissions. `.autopilot/**`,
  `.github/workflows/**`, lockfiles in default `protected_paths`.
* **C2 — Auth scope.** Default to fine-grained PAT (issues +
  PRs + branch-prefixed contents-write only); `gh` CLI labeled
  "unsafe/dev mode"; hosted uses per-org GitHub App.
* **C3 — Sandboxed phase execution.** Per-phase Docker/Podman
  container locally; per-run isolated worker hosted; credential
  mounts blocked; egress allowlist (GitHub + Anthropic + OpenAI +
  package registries).
* **W3 — Auto-merge.** Requires distinct `automerge.*` policy
  block with `required_checks`, `require_codeowner_approval`,
  `max_risk_level`, `allowed_paths`, `rollback_plan_required`.
* **W4 — Phase-level idempotency.** Operation IDs + side-effect
  markers; restart reconciles GitHub state before resuming.
* **N1 — OS keychain** for local secrets (macOS Keychain / Linux
  Secret Service / Windows Credential Manager via `keytar`);
  fallback to `~/.claude-autopilot/keys.json` 0600 with warning.

**Updated stabilization criteria** add:
* Sandbox-escape attempt suite (planted-payload tests verify
  malicious `npm test` cannot read `~/.ssh/`, `~/.aws/`, host
  `gh` token).
* Phase-level idempotency suite (kill daemon mid-phase × 100;
  restart produces zero duplicate side-effects).

3 smaller open questions remain for v8.0-beta lock (container
runtime fallback, hosted worker latency, sandbox network
allowlist customization).

No code change; bumping to 7.2.1 to keep CHANGELOG/version in
lockstep with master HEAD.

## 7.2.0 (2026-05-10)

**v7.2.0 — `claude-autopilot scaffold --from-spec <path>`.** Closes
the biggest remaining day-1 friction the v7.1.6 blank-repo benchmark
identified. Even with auto-scaffolded `CLAUDE.md` + `.gitignore`
(v7.1.7), a fresh repo still needs a hand-written `package.json`,
`tsconfig.json`, and directory skeleton before any feature work
happens. The new verb collapses that step.

**New verb** reads a spec markdown file's `## Files` section and:

* Creates listed directories (`mkdir -p`).
* Creates empty placeholder files for each path in the section.
* Generates a starter `package.json` (Node 22 ESM defaults +
  hint-merged `bin` / `dependencies` / `scripts` parsed loosely
  from the spec prose).
* Generates a starter `tsconfig.json` — JS-flavor (`allowJs +
  checkJs + noEmit`) when the spec lists predominantly `.js` files,
  TS-flavor (compiled to `dist/`) for `.ts` files.

**Never overwrites existing files** — operator opted into autopilot,
not into us nuking their package.json. Reports `· exists` for each
preserved file. Idempotent: re-running on a partially-scaffolded
repo only fills the gaps.

`--dry-run` flag logs what would happen without writing.

**End-to-end smoke**: scaffold from the actual v7.1.6 benchmark
spec produces a 100%-correct skeleton in ~50ms (3 dirs + 5
placeholder files + matching package.json bin/deps/scripts).

**Out of scope (deferred to v8):**

* Per-stack scaffolding (Python `pyproject.toml`, Go `go.mod`,
  Rust `Cargo.toml`). v7.2.0 ships Node ESM only — covers the
  v7.1.6 benchmark stack and the most common starter case.
* Running `npm install`. Operator picks the package manager.

11 new tests (4 parser + 2 builder + 5 end-to-end). 1548 → 1559
CLI tests; tsc clean; build clean. New verb registered in
`src/cli/index.ts` + listed in `Pipeline:` help group. Version
7.1.9 → 7.2.0 (minor bump for new verb surface).

## 7.1.9 (2026-05-10)

**v7.1.9 — build fix + Generic-stack next-steps hint.** Two
micro-fixes from the v7.1.8 benchmark re-run.

* **`canonicalize` declared at root** (`package.json`). The CLI's
  `src/dashboard/upload/canonical.ts` (RFC 8785 / JCS parity copy
  of `apps/web/lib/upload/canonical.ts`) imports `canonicalize`
  but the module was only declared in `apps/web/package.json`.
  Root build hit `TS2307: Cannot find module 'canonicalize'` even
  though the package was actually installed via npm hoisting. Now
  declared at root — `npm run build` from a fresh clone is clean.
* **Generic+low-confidence next-steps hint** (`src/cli/setup.ts`).
  The v7.1.8 benchmark re-run on a truly blank repo reported
  "Detected: Generic (low confidence)" with no actionable next
  step. Setup now surfaces a one-liner:
  `npm init -y` → `npx claude-autopilot setup --force`. Skipped
  silently on high-confidence detections (the common case).

2 new tests (`tests/setup.test.ts`); 1546 → 1548 CLI tests; tsc
clean; build clean. Version 7.1.8 → 7.1.9.

## 7.1.8 (2026-05-10)

**v7.1.8 — blank-repo benchmark re-run on v7.1.7.** Docs-only PR.
Friction-reduction delta measurement after the v7.1.7 polish PR.

**All three v7.1.7 fixes verified end-to-end** on a fresh `git init`
repo:

* `.gitignore` auto-created with `.guardrail-cache/` + `node_modules/`.
* `CLAUDE.md` auto-scaffolded with detected stack, test command,
  Conventional Commits convention, error class shape, branch
  naming, TODO slots.
* Deprecation banner deduped per UTC day via
  `~/.claude-autopilot/.deprecation-shown` stamp.

**Friction score: 3 of 6 v7.1.6 friction points closed; 1 partially
closed; 2 deferred.** Matches v7.1.6 prediction ("would close ~5 of
6") with minor over-promise.

**New friction surfaced:**

* Stale `dist/` after merge requires `npm run build` for local
  contributors (invisible to `npm install -g` users).
* Build hits one stale TS error (`canonicalize` not declared at
  root level) — 4 v7.1.7 helpers compiled, setup ran end-to-end,
  filing as separate followup.
* `Detected: Generic (low confidence)` on truly blank repos —
  honest but suggests next-step "scaffold a `package.json` first
  for higher-confidence detection."

**New recommendations:** suggest stack-scaffold step in `setup`
next-steps when detection is `Generic` (~20min ship);
`scaffold --from-spec` verb (deferred from v7.1.6, ~1-day);
per-stack starter `tsconfig.json` / `pyproject.toml` (~2-4hr per
stack).

**Methodology caveat:** Phase B (impl agent) NOT re-run — wall-clock
impact is downstream and would need another full agent dispatch to
measure precisely. The friction-point table tells most of the story.

Full report at `docs/benchmarks/2026-05-10-blank-repo-v7.1.7.md`.
No code change; bumping to 7.1.8 to keep CHANGELOG/version line in
lockstep with master HEAD.

## 7.1.7 (2026-05-10)

**v7.1.7 — `setup` verb day-1 polish.** Three fixes from the v7.1.6
blank-repo benchmark report. Operator-facing improvements; no
breaking changes; no migration.

* **Per-calendar-day deprecation dedup** (`bin/_launcher.js`). The
  v6.3+ stamp was keyed by `process.ppid + tty/pipe` — fine for
  interactive shells, broken for git hooks (fresh shell per hook =
  fresh ppid = stamp re-created every commit, notice printed every
  commit). New stamp at `~/.claude-autopilot/.deprecation-shown`
  contains `YYYY-MM-DD` and dedups by UTC day per machine.
  Override env vars (`CLAUDE_AUTOPILOT_DEPRECATION=always|never`)
  preserved.
* **Auto-add `node_modules/` + `.guardrail-cache/` to `.gitignore`**
  on `setup` (`src/cli/setup.ts`). New `ensureGitignoreEntries()`
  helper: idempotent (re-running never duplicates), preserves
  existing entries, creates `.gitignore` from scratch if missing.
* **Auto-scaffold starter `CLAUDE.md`** when one doesn't exist
  (`src/cli/setup.ts`). New `ensureStarterClaudeMd()` helper writes
  ~35 lines covering: detected stack + confidence, test command,
  Conventional Commits convention, error class shape, branch naming,
  TODO slots for "patterns to mimic" + "common pitfalls". Closes
  ~5 of 6 friction points the benchmark agent reported. Never
  overwrites an existing `CLAUDE.md`.

13 new tests (4 setup + 6 launcher + 3 idempotency / overwrite-safety).
1539 → 1546 CLI tests. tsc clean. Version bump 7.1.6 → 7.1.7 to
keep CHANGELOG/version line in lockstep with master HEAD.

## 7.1.6 (2026-05-09)

**v7.1.6 — blank-repo benchmark report.** Docs-only PR. Captures
the day-1 experience of using `claude-autopilot` on a true `git init`
repo, end-to-end from "empty directory" to "feature shipped + tests
passing." Triggered by codex W5 from the autopilot product-direction
brainstorm.

**Headline:** ~17 minutes from `git init` to working MVP (small CLI,
Node 22 ESM, with a real Anthropic API call). Setup itself is ~6
seconds. Pre-commit static-rules hook caught accidentally-staged
secrets on day 1 (real-world value, not theoretical).

**Top friction points:** no `CLAUDE.md` scaffolded by `setup`;
deprecation banner prints on every commit; `.gitignore` doesn't
auto-add `node_modules/` or `.guardrail-cache/`; no `scaffold
--from-spec` verb.

**Top recommendations:** dedup deprecation banner (~30min ship),
auto-add cache dirs to `.gitignore` (~10min ship), auto-scaffold
starter `CLAUDE.md` on `setup` (~2-4hr ship). Fully-autonomous-from-
blank requires Option C (standalone daemon) work first — flagged as
v8 dependency.

Full report at `docs/benchmarks/2026-05-09-blank-repo.md`. Bumping
to 7.1.6 to keep CHANGELOG/version line in lockstep with master HEAD.

## 7.1.5 (2026-05-09)

**v7.1.5 — change-aware CI matrix.** CI infra optimization;
no application code change; no test additions.

The v7.0+ repo runs 6 GitHub Actions workflows on every PR
(bin smoke ×6 OS×Node + Test Node 22 + Delegance regression +
tarball check + apps/web typecheck/build/tests + RLS). Many of
those are irrelevant to PRs that only touch a different layer
(apps/web-only PRs don't need bin smoke; CLI-only PRs don't
need apps/web tests; docs-only PRs don't need anything).

Each workflow's `pull_request:` trigger now includes a `paths:`
filter — GitHub Actions skips the workflow entirely on PRs that
don't touch any matching file:

* `ci.yml` (Test Node 22), `bin-parity.yml` (bin smoke ×6),
  `delegance-regression.yml`: triggered by CLI changes (`src/**`,
  `bin/**`, `tests/**` for ci.yml, `scripts/**`, `presets/**`)
  and conservative shared paths (`tsconfig*`, `package.json`,
  `package-lock.json`, the workflow file itself).
* `web-tests.yml`: triggered by `apps/**`, `tsconfig*`,
  `package.json`, `package-lock.json`, the workflow file.
* `db-tests.yml`: triggered by `db/**`, `tests/rls/**`,
  `package.json`, `package-lock.json`, the workflow file.
* `npm-tarball-check.yml`: triggered by anything that affects
  the published artifact (`package.json`, `.npmignore`,
  `package-lock.json`, CLI source).

**Codex pass W4 safety net:** `push:` triggers (master + tag
pushes) deliberately have NO `paths:` filter. Every master merge
runs the full matrix, catching anything that slipped past the
PR-level filter (e.g. a config change in a directory we forgot
to enumerate). The PR-level filter is a latency optimization,
not a correctness boundary.

**Expected effect:** apps/web-only PRs (Phase 5.7-7.1.4 polish
shape) drop from ~12-15min CI wall clock to ~5-7min. Docs-only
PRs become a no-op CI run.

No package code change; bumping to 7.1.5 to keep CHANGELOG/
version-line in lockstep with master HEAD.

## 7.1.4 (2026-05-09)

**v7.1.4 — fix recurring PGRST002 RLS workflow flake.** CI infra
fix; no application code change; no test additions. Phase 5.1, 5.7,
and 7.1.3 all hit the same intermittent failure in the RLS negative
tests workflow:

```
PGRST002 — Could not query the database for the schema cache. Retrying.
```

PostgREST caches the database schema asynchronously AFTER
`supabase db reset` returns. The first SDK queries from the test
runner often arrive before the cache has finished warming, hard-
failing instead of waiting.

Fix: new "Wait for PostgREST schema cache to warm up" workflow step
between `Apply migrations` and `Run RLS tests`. Polls
`GET /rest/v1/` (PostgREST OpenAPI doc) up to 60s; succeeds on the
first response that parses as JSON with an `info` field. Times out
with diagnostic body if the cache doesn't warm.

Changes only `.github/workflows/db-tests.yml`. No package code
change, but bumping to 7.1.4 to keep version-line/CHANGELOG in
lockstep with master HEAD.

## 7.1.3 (2026-05-09)

**v7.1.3 — `/api/health/v7-readiness` deploy-verification endpoint.**
Hosted product (`apps/web/`) only. Operator-facing improvement; no
breaking changes; no migration.

* New `GET /api/health/v7-readiness` route, gated by
  `Authorization: Bearer ${CRON_SECRET}` (constant-time compare via
  `crypto.timingSafeEqual`).
* Verifies in one HTTP call:
  - `check_membership_status` RPC is present + executable (closes
    codex PR #141 PR-pass WARNING #3 — the Phase 6 migration must
    be applied before deploying any v7.0+ web image, or every
    org-scoped dashboard request returns `check_failed` within 60s).
  - All 12 required env vars are set (Supabase, Stripe, WorkOS,
    JWT/SSO/cookie secrets meeting ≥32-byte minimums where
    applicable).
* Response: `200 {ok: true, totalChecks, passed, failed: 0, checks}`
  on full pass; `503 {ok: false, ...}` with per-check
  `{name, status, required, message?}` diagnostic on any required
  failure.
* Operator runbook updated with `curl -fsSL` example for an
  automated deploy-step gate.
* 8 new tests in `apps/web/__tests__/api/health/v7-readiness.test.ts`
  covering happy path, missing env, too-short secret, RPC missing,
  three auth-failure modes (no header, wrong secret, malformed
  Bearer), and missing CRON_SECRET → 500.
* 613 → 621 web tests; 1536 CLI unchanged; tsc clean.

## 7.1.2 (2026-05-09)

**v7.1.2 — configurable membership-check TTL.** Hosted product
(`apps/web/`) only. Operator-facing improvement; no breaking changes;
no migration.

* New optional env var `MEMBERSHIP_CHECK_TTL_SECONDS` overrides the
  default 60s `cao_membership_check` cookie TTL. Bounded `[1, 3600]`.
* Lower TTL = tighter revocation window (≤N seconds for a disabled
  member to see 403 on next dashboard request) at the cost of more
  `check_membership_status` RPC calls per dashboard navigation.
* Higher TTL = fewer RPC calls but extends the v7.0 documented
  "≤60s revocation latency" guarantee.
* Invalid values (non-integer, < 1, > 3600) silently fall back to 60
  with a one-shot warn (same pattern as the v7.1.1 PREVIOUS-secret
  validator).
* 6 new tests in `cookie-hmac.test.ts` cover: default 60 when unset;
  valid integer in range; non-numeric falls back; float falls back;
  out-of-range (< 1, < 0, > 3600) falls back; signed cookie exp
  respects the configured TTL via sign+verify roundtrip.
* 607 → 613 web tests; 1536 CLI unchanged; tsc clean.

## 7.1.1 (2026-05-09)

**v7.1.1 — dual-secret rotation for `MEMBERSHIP_CHECK_COOKIE_SECRET`.**
Hosted product (`apps/web/`) only. Operator-facing improvement;
no breaking changes; no migration; no new tests fail/skip.

* New optional env var `MEMBERSHIP_CHECK_COOKIE_SECRET_PREVIOUS`.
  When set, `verifyMembershipCookie()` tries `CURRENT` first; on
  signature mismatch, tries `PREVIOUS`. New cookies always sign
  with `CURRENT`. Closes the v7.0 runbook follow-up where rotating
  the secret invalidated every outstanding cookie at once = a
  thundering-herd of `check_membership_status` RPC calls on every
  active dashboard session.
* Operator rotation flow (4 steps) documented in `docs/v7/runbook.md`
  + `apps/web/.env.example`.
* `MEMBERSHIP_CHECK_COOKIE_SECRET_PREVIOUS` validation: same
  ≥32-byte minimum as `CURRENT`. Malformed/too-short `PREVIOUS`
  is ignored with a one-shot warn — does not break the happy path.
* 5 new tests in `apps/web/__tests__/lib/middleware/cookie-hmac.test.ts`
  cover: PREVIOUS verifies during rotation; new cookies sign with
  CURRENT not PREVIOUS; forged-third-secret fails even with both;
  PREVIOUS unset behaves identically to v7.1.0; PREVIOUS too short
  is ignored without breaking CURRENT.
* 602 → 607 web tests; 1536 CLI unchanged; tsc clean.

## 7.1.0 (2026-05-09)

**v7.1 — symmetric ingest revocation closure.** Hosted product
(`apps/web/`) only. Closes the JWT-authenticated ingest gap that v7.0
Phase 6 explicitly deferred: collapses the per-request revocation
window from ≤15min (the JWT TTL) to **≤1 request** for org-scoped runs.

### apps/web — JWT-authenticated ingest membership re-check

- New helper `assertActiveMembership(claims)` in
  `apps/web/lib/upload/membership-recheck.ts` — calls the existing
  Phase 6 `check_membership_status` RPC and maps statuses to typed
  errors. Personal runs short-circuit via `!claims.org_id`. Authority
  is `claims.org_id`; the new `mint_status` claim is observability-
  only (codex pass-1 CRITICAL #2 — closed bypass where a v7.0 token
  could skip the check).
- New orchestrator `verifyTokenAndAssertRunMembership(token, runId,
  supabase)` in `apps/web/lib/upload/auth.ts` — single chokepoint that
  every JWT-authenticated ingest route calls. Combines (1) JWT shape
  + signature verify, (2) JWT.run_id ↔ route runId consistency,
  (3) persisted runs lookup, (4) JWT.org_id ↔ run.organization_id
  consistency (closes cross-org JWT replay AND personal-shortcut
  bypass — codex pass-3 CRITICAL #2), and (5) per-request membership
  re-check.
- `PUT /api/runs/:runId/events/:seq` and `POST /api/runs/:runId/finalize`
  both call the orchestrator before any side-effect RPC / Storage
  write. Disabled / inactive / no-membership returns 403; transient
  RPC failure returns retryable 503; opaque 404 for run mismatches
  (no enumeration leakage).
- `POST /api/upload-session` does its own pre-mint
  `check_membership_status` RPC for org-scoped runs. Non-active
  members get 403 `member_not_active` + `audit_events` row with
  `action: 'ingest.mint_refused'`. No upload session created on
  refusal. RPC failure → 503 (retryable parity with event-write/
  finalize, codex pass-2 WARNING #2).
- JWT shape: `UploadTokenClaims.org_id` is now `string | null` (verify
  normalizes wire-format `''` → `null`); new optional
  `mint_status: 'active' | 'personal'` claim. `MintInput.mintStatus`
  is required.
- `verifyUploadToken()` is preserved for the JWT-shape unit tests but
  marked `@deprecated`. Routes under `app/api/runs/**` are blocked
  from importing it directly via ESLint `no-restricted-imports`
  (`apps/web/.eslintrc.json`). Defense-in-depth chokepoint
  (codex pass-3 WARNING #5).

### Tests

- 32 new/modified web tests (566 → 598). Coverage: mint-time
  membership snapshot (4), event-write re-check (8 — incl. ordering
  spy + v7.0-shape regression), finalize re-check (4), helper unit
  (10 — status enum + RPC error + personal shortcut + v7.0
  back-compat), end-to-end disable-mid-session (1), identity invariant
  (3), JWT shape (4 modified).
- `__tests__/_helpers/supabase-stub.ts` adds a
  `check_membership_status` RPC handler that reads from the seeded
  `memberships` table.

### Documentation

- `docs/v7/breaking-changes.md` — appended "v7.0 → v7.1" section
  covering the rollout (no coordinated cutover; in-flight org-scoped
  tokens enforce immediately).
- `apps/web/lib/dashboard/auth.ts` — extended the API-key audit
  comment block with the new ingest-API JWT caller list and the
  invariant.

### No SQL migration

Phase 6's `check_membership_status` RPC is reused verbatim. v7.1 ships
pure TypeScript + a single test-stub change.

## 7.0.0 (2026-05-09)

**v7.0 — hosted product MVP cutover.** First major bump since v6.0
(2026-04-22). Drops the engine-off code path, ships the autopilot.dev
hosted dashboard MVP, closes the last operational gap in dashboard
session revocation, and bumps the run-state schema_version to mark the
v7 era.

### Breaking changes (read this first)

See [docs/v7/breaking-changes.md](docs/v7/breaking-changes.md) for the
full migration checklist. The shortlist:

- **`--no-engine` removed.** Exits 1 with `invalid_config` if passed.
  The engine is unconditionally on.
- **`CLAUDE_AUTOPILOT_ENGINE=off` removed (soft).** The env value is
  ignored — engine still runs — but a one-shot stderr deprecation
  banner fires + a `run.warning` event with code `engine_off_removed`
  is emitted into the durable run log. Softer than `--no-engine`
  because env vars in CI are sticky.
- **`ENGINE_DEFAULT_V6_0` and `ENGINE_DEFAULT_V6_1` exports removed**
  from `src/core/run-state/resolve-engine.ts`. Direct importers must
  replace with literal `true`. `resolveEngineEnabled()` itself is
  preserved for source compatibility but always returns
  `{enabled: true, source: 'default'}`.
- **`runEngineOff` callback on `runPhaseWithLifecycle` is preserved as
  optional**, but the helper NEVER invokes it in v7.0. New call sites
  should omit it.
- **`RUN_STATE_SCHEMA_VERSION` bumped 1 → 2.** v6.x runs are still
  readable on v7 (`MIN_SUPPORTED` stays at 1). v6 binaries reading v7
  runs hit a `corrupted_state` error with a "downgrade resume is not
  supported" hint + `[1..1]` range.
- **`--engine` becomes a no-op shim** with one-shot per-process
  stderr deprecation banner. Flag preserved so existing scripts don't
  break; remove at your leisure (slated for v8).

### apps/web — real-time membership revocation

- New middleware extension on `/dashboard/**` and `/api/dashboard/**`.
  Verifies the `cao_active_org` cookie + the HMAC-signed
  `cao_membership_check` cookie cache; on miss/expired/wrong-identity,
  calls the new `check_membership_status(p_org_id, p_user_id)` RPC
  (1.5s timeout, fail-closed on error).
- Worst-case revocation window collapses from ≤1h (= access-token
  expiry, the v6 baseline) to ≤60s (= cookie cache TTL).
- New env var: `MEMBERSHIP_CHECK_COOKIE_SECRET` (≥32 bytes;
  `openssl rand -hex 32`). Lazy/runtime validation — `next build` in
  CI without the secret won't crash; middleware fails closed at
  request time if missing.
- Middleware runtime explicitly set to `nodejs` (was Edge default).
  Required for `node:crypto` HMAC + `crypto.timingSafeEqual`.
- New page: `/access-revoked?reason=<code>` (Server Component, NOT
  auth-gated, does NOT auto-forward authenticated users to avoid
  redirect loops). Renders one of four reasons with a Sign-out form.
- Status → reason mapping table is the single source of truth (codex
  pass-3 WARNING #5):
  - `disabled` → `member_disabled`
  - `inactive` / `invite_pending` → `member_inactive`
  - `no_row` → `no_membership`
  - RPC error / timeout → `check_failed`
- New SQL migration: `data/deltas/20260509200000_phase6_check_membership_rpc.sql`.
  `SECURITY INVOKER` (NOT DEFINER per codex pass-2 WARNING #5 +
  pass-3 WARNING #2 — `service_role` bypasses RLS already, so DEFINER
  would only widen blast radius). REVOKE'd from PUBLIC/anon/authenticated;
  GRANT EXECUTE to `service_role` only.

### Deferred to v7.1

- `MEMBERSHIP_CHECK_TTL_SECONDS` env var to let enterprise customers
  tighten the 60s cache window.
- Server-side cache invalidation on `change_member_role` /
  `disable_member` (would tighten role-change visibility from ≤60s to
  immediate).
- Phase 2.2 ingest API JWT mint embeds `mint_membership_status` so
  finalize/event endpoints can refuse disabled members within the
  ≤30min JWT TTL.

### Documentation

- New: `docs/v7/breaking-changes.md` — explicit v6 → v7 migration
  checklist.
- New: `docs/v7/runbook.md` — production deployment runbook for the
  hosted product (Vercel env vars grouped by purpose, WorkOS dashboard
  hookups, Stripe products + webhook config, cron secret rotation,
  first-deploy checklist).
- README — new "Hosted product (v7)" section pointing at autopilot.dev,
  install snippet updated to `npm install -g
  @delegance/claude-autopilot@latest`.
- `docs/v6/migration-guide.md` — appended v6.2.x → v7.0 section.

### CI / publishing

- `.github/workflows/ci.yml` now tags pushes matching
  `v[0-9]+.[0-9]+.[0-9]+` (no suffix) with `--tag latest`; everything
  else stays `--tag next`. `package.json` `publishConfig.tag` stays at
  `next` as a hand-publish fallback only — the workflow is the source
  of truth.

### Phase rollup (v7.0 cycle)

- **Phase 1** (schema/RLS) — multi-tenant Postgres + RLS policies for
  the hosted product.
- **Phase 2.1** (Next.js scaffold) — `apps/web/` workspace, Vercel
  deploy.
- **Phase 2.2** (ingest API) — signed-session JWT pipeline for
  CLI → dashboard run uploads.
- **Phase 2.3** (CLI dashboard verbs) — `dashboard {login,logout,
  status,upload}` + cli-auth loopback OAuth.
- **Phase 3** (Stripe) — entitlements, tiered pricing, webhook.
- **Phase 4** (dashboard UI + cli-auth hardening) — homepage, auth,
  CSP-locked /cli-auth.
- **Phases 5.1-5.4** (org admin / WorkOS setup) — members, audit, cost,
  per-tenant SSO connection management.
- **Phase 5.6** (WorkOS sign-in) — domain verification, SSO
  enforcement chokepoint.
- **Phase 5.7** (admin lifecycle) — disable_member, sso_disconnect,
  enable_member, last-owner race protection.
- **Phase 5.8** (lifecycle gap closure) — disabled-API-key
  authorization fix + Vercel cron for cleanup_expired_sso_states.
- **Phase 6** (this release) — engine-off removal, schema bump, real-
  time membership revocation, runbook, breaking-changes docs.

### Tests

- 1500+ existing CLI tests pass (engine-off tests collapsed to
  always-on; net delta near zero).
- 510 → 566 web tests (+56 across cookie-hmac, check-membership, RPC
  privilege grep, middleware revocation surface, response composition,
  matcher, integration).
- tsc clean across both `@delegance/claude-autopilot` and
  `@delegance/claude-autopilot-web`.

## 6.3.0-pre.13 (2026-05-09)

**v7.0 Phase 5.8 — Lifecycle gap closure.** Closes the two known gaps from Phase 5.7:

1. **Disabled-API-key authorization fix.** The Phase 2.2 `upload-session` and Phase 4 `artifact` routes had `let allowed = run.user_id === auth.userId` as the first authorization check. This allowed a member who got disabled AFTER creating an org-scoped run to keep uploading via their API key. Both routes now ALWAYS require active membership when `run.organization_id` is set, regardless of ownership. Personal (un-org-scoped) runs still use the ownership check. Regression test (`__tests__/api/dashboard/runs/disabled-api-key.test.ts`, 4 cases) locks this in.
2. **Vercel cron wiring for `cleanup_expired_sso_states` RPC.** New `GET /api/cron/cleanup-expired-sso-state` route (Vercel cron-secret-gated; rejects any caller without `Authorization: Bearer ${CRON_SECRET}`). Schedule `0 3 * * *` (daily 03:00 UTC) added to `vercel.json`. Calls the Phase 5.7 RPC with default args (24h state age, 30d event age). 4-test coverage (auth happy/fail paths + missing env).

New env: `CRON_SECRET` (Vercel sets automatically on production cron-attached projects; local-dev override via `.env.local`). Documented in `.env.example`.

Tests: 502 → 510 web. tsc clean.

## 6.3.0-pre.12 (2026-05-09)

**v7.0 Phase 5.7 — Admin lifecycle controls + session revocation.** Closes the lifecycle/revocation gap that Phases 5.4 and 5.6 explicitly deferred.

Three lifecycle controls:

1. **Admin disable-user** — `POST /api/dashboard/orgs/:orgId/members/:userId/disable` flips `memberships.status='disabled'`, captures `disabled_at`/`disabled_by`, deletes `auth.refresh_tokens` for the user. Existing access tokens expire ≤1h (Supabase default; documented in spec). Idempotent on already-disabled (returns `noop:true`, no duplicate audit, no duplicate revocation). Owner-protection (admin cannot disable owner) + last-owner guard.
2. **SSO disconnect cascade** — `apply_workos_event(connection.deleted)` set-based DELETE of refresh tokens for org members (status active OR disabled per codex plan-pass WARNING #1) with verified-domain emails. Audit metadata captures `cascadeRevokedUserCount` + `cascadeRevokedTokenCount` (no user IDs per plan-pass WARNING #5).
3. **`cleanup_expired_sso_states` RPC** — service-role only, called via `scripts/cleanup-expired-sso-state.ts` (no HTTP route per codex pass-1 CRITICAL #3). Phase 6 wires a cron.

Migration `data/deltas/20260509140000_phase5_7_lifecycle.sql`:
- ALTER `memberships.status` CHECK extended with `'disabled'` + `disabled_at`/`disabled_by` columns.
- 4 new SECURITY DEFINER RPCs (REVOKE FROM PUBLIC,anon,authenticated; GRANT TO service_role): `revoke_user_sessions`, `disable_member`, `enable_member`, `cleanup_expired_sso_states`.
- 2 RPC REPLACEs: `record_workos_sign_in` now refuses `member_disabled` / `member_inactive` / `invite_pending` (codex pass-2 WARNING #1); `apply_workos_event` adds set-based cascade DELETE on `connection.deleted`.

Surfaces:
- `POST /api/dashboard/orgs/:orgId/members/:userId/disable` (admin/owner-gated).
- `POST /api/dashboard/orgs/:orgId/members/:userId/enable` (admin/owner-gated, symmetric owner protection — only owners can re-enable owners per pass-2 WARNING #3).
- `GET /api/auth/sso/callback` modified to redirect 302 → `/login/sso?reason={member_disabled|member_inactive|invite_pending}` instead of returning 403 JSON.

`/login/sso` page renders 3 new banner reasons. `lib/dashboard/membership-guard.ts` MAP gains 10 new error codes. `package.json` 6.3.0-pre.11 → 6.3.0-pre.12.

Tests: 6 new test files (49 tests). disable.test.ts (11), enable.test.ts (4), webhook-cascade.test.ts (5), sso-signin-phase5-7.test.ts (4), phase5-7-privilege.test.ts (16 grep assertions), cleanup-expired-sso-state.test.ts (4), disabled-user-jwt.test.ts (4 — codex plan-pass CRITICAL #2 regression: proves disabled member with still-valid JWT can't access dashboard routes via 4 representative paths). 451 → 500 web tests. tsc clean.

**Known gaps (Phase 5.8):**
- API keys (Phase 2.3) are user-scoped not org-scoped; disabling membership in org A doesn't auto-revoke. Phase 5.8 will add a membership-active check in the API-key auth helper.
- Access-token expiry is the upper bound on revocation latency (≤1h Supabase default). Real-time revocation requires a request-time denylist + middleware (Phase 6).
- Cleanup script not yet cron-scheduled (Phase 6).

**Codex passes folded:** spec pass-1 (3C+5W+2N), pass-2 (1C+6W), plan-pass (2C+6W+2N). Highlights: dropped global API-key revocation due to cross-tenant blast (gap explicitly documented + deferred); cascade scope includes `'disabled'` per plan WARNING #1; audit metadata drops user IDs sample per plan WARNING #5; explicit disabled-user-JWT regression test proves spec's enforcement-audit table is correct.

## 6.3.0-pre.11 (2026-05-09)

**v7.0 Phase 5.6 — WorkOS SSO sign-in flow.** End-to-end SSO sign-in built on the Phase 5.4 foundation. Three sub-features that ship together (any subset is unusable):

- **Domain claim with DNS TXT challenge.** Admin-gated `POST/DELETE /api/dashboard/orgs/:orgId/sso/domains` + `POST .../verify`. Codex pass-1 CRITICAL #1 — `ever_verified` flag + unique partial index on `(lower(domain)) WHERE ever_verified=TRUE` blocks revoke-then-takeover by another org.
- **Sign-in flow.** Public `POST /api/auth/sso/start` (email-only — `orgId`-mode removed for anti-enumeration per codex pass-2 WARNING #8) → `GET /api/auth/sso/callback`. State binding (codex pass-2 CRITICAL #2): single canonical protocol — cookie holds HMAC-signed `{stateId, nonce}`, WorkOS state param = stateId only, server-stored `sso_authentication_states` row + atomic `consume_sso_authentication_state` RPC validates `(stateId, sha256(nonce))` + workos org/connection match. Session minted via admin-mediated magic link (codex pass-1 CRITICAL #4 — `verifyOtp` uses `token_hash` not `token`); session-user-mismatch verification revokes + audits + 500.
- **`sso_required` toggle.** Owner-only `PATCH /api/dashboard/orgs/:orgId/sso/required`. Asymmetric guard (codex pass-1 WARNING #7): turning OFF always allowed; turning ON requires active SSO. UI banner per codex pass-2 NOTE #2 explains the asymmetric state.

Single chokepoint enforcement: `enforceSsoRequired()` helper called from `/api/auth/callback` after every Google/magic-link `exchangeCodeForSession`. Sign-in surface registry table in spec documents the auth boundary.

Identity link (codex pass-1 WARNING #6): `workos_user_identities` table preserves `(workos_user_id, workos_organization_id) → user_id` mapping so future sign-ins re-use the same Supabase user even if IdP email changes. Magic link minted with the linked Supabase user's CURRENT email (looked up via `auth.admin.getUserById`), not the WorkOS profile email.

Migration `data/deltas/20260509120000_phase5_6_workos_signin.sql`:
- ALTER `organization_settings` ADD `sso_required BOOLEAN DEFAULT FALSE`.
- 3 new tables (`organization_domain_claims`, `sso_authentication_states`, `workos_user_identities`) with RLS + service-role grants.
- 6 SECURITY DEFINER RPCs: `claim_domain`, `mark_domain_verified`, `revoke_domain_claim`, `set_sso_required`, `consume_sso_authentication_state` (atomic UPDATE...RETURNING per codex plan-pass WARNING #5), `record_workos_sign_in` (verified-domain match required per codex pass-1 CRITICAL #3). All REVOKE FROM PUBLIC,anon,authenticated; GRANT TO service_role.

New deps: `tldts` (maintained PSL package per codex pass-1 NOTE #1).
New env vars: `SSO_STATE_SIGNING_SECRET` (≥32 bytes, module-load validation per codex plan-pass WARNING #4), `WORKOS_CLIENT_ID` (required by `workos.sso.getAuthorizationUrl`).

Helpers:
- `lib/dns/normalize-domain.ts` — `normalizeDomain` + `normalizeEmailDomain` (IDN, public-suffix-aware) used by every domain-touching surface.
- `lib/dns/verify-txt.ts` — `Promise.race`-bounded TXT lookup (codex pass-2 WARNING #4 — `node:dns/promises.resolveTxt` doesn't honor AbortSignal).
- `lib/auth/enforce-sso-required.ts` — sign-in surface chokepoint.
- `lib/workos/sign-in.ts` — `getSsoStateSigningSecret` (length-validated singleton), `signStateCookie` / `parseStateCookie` (HMAC), `buildAuthorizeUrl` (passes clientId per codex plan-pass CRITICAL #3).
- `lib/dashboard/membership-guard.ts` MAP gains 13 new error codes.

UI:
- `/login/sso` page + `<SsoSignInForm>` client component.
- `<SsoDomainsCard>` + `<SsoRequiredToggle>` embedded in admin SSO page (toggle renders even when SSO inactive per codex pass-1 WARNING #7).

Tests: 5 new test files (54 tests). domains.test.ts (11), required.test.ts (4), start.test.ts (5), callback.test.ts (10), sso-signin-privilege.test.ts (13), normalize-domain.test.ts (19), verify-txt.test.ts (6), enforce-sso-required.test.ts (7), sign-in.test.ts (11). Stub extensions for 7 new RPCs (`claim_domain`, `mark_domain_verified`, `revoke_domain_claim`, `set_sso_required`, `consume_sso_authentication_state`, `record_workos_sign_in`, `audit_append`) + 3 new tables + `auth.admin.{getUserById,createUser,generateLink,signOut}` + `auth.verifyOtp` mocks.

## 6.3.0-pre.10 (2026-05-08)

**v7.0 Phase 5.4 — WorkOS SSO setup.** Foundational SSO wiring: server-owned WorkOS organization correlation, admin-gated portal link, signature-verified lifecycle webhook, owner-gated disconnect.

New env vars: `WORKOS_API_KEY`, `WORKOS_WEBHOOK_SECRET`.

Migration `data/deltas/20260508180000_phase5_4_workos_setup.sql`:
- ALTER `organization_settings` adds 7 SSO columns (workos_organization_id, workos_connection_id, sso_connection_status, sso_connected_at, sso_disabled_at, sso_last_workos_event_at, sso_last_workos_event_id) + unique partial indexes on workos_organization_id and workos_connection_id.
- New `processed_workos_events` ledger with claim/lease/complete columns (status, processing_started_at, locked_until, attempt_count) — enables idempotent webhook retry.
- Three SECURITY DEFINER RPCs (REVOKE FROM PUBLIC,anon,authenticated; GRANT service_role): `record_sso_setup_initiated` (admin-gated, raises `workos_org_already_bound` if a different active WorkOS org would be swapped), `apply_workos_event` (claim/lease/complete + lifecycle ordering via sso_last_workos_event_at + state transition + audit append in one txn — connection.deleted always wins over older updated), `disable_sso_connection` (owner-only soft-disable).

Surfaces:
- `POST /api/dashboard/orgs/:orgId/sso/setup` — 6-step admin-gated portal-link sequence. Server-creates the WorkOS org via `externalId=orgId` so correlation is server-owned; idempotent on retry. Returns `{ portalUrl, workosOrganizationId }` with `Cache-Control: private, no-store`.
- `DELETE /api/dashboard/orgs/:orgId/sso` — owner-only two-step disconnect (RPC sets status='disabled'; route then calls `workos.sso.deleteConnection`; failure non-fatal — eventual `connection.deleted` webhook clears connection_id via apply_workos_event).
- `POST /api/workos/webhook` — runtime nodejs, raw `req.text()` body, HMAC verified via `workos.webhooks.constructEvent` (5-min tolerance). Maps connection.activated/deactivated/deleted (and dsync.* variants) through apply_workos_event RPC. 401 on bad signature, 500 on RPC error so WorkOS retries.
- `/dashboard/admin/sso` page (owner-only, 404 otherwise) + `<SsoSetupCard>` client component.

Helpers:
- `lib/workos/client.ts` — lazy `getWorkOS()` singleton + async `verifyWorkOSSignature()` wrapper (returns `{ok, event} | {ok:false, reason}`).
- `lib/dashboard/membership-guard.ts` MAP gains `workos_org_already_bound: 422`, `bad_workos_org_id: 422`, `webhook_signature_invalid: 401`.

Sidebar: admin layout adds "SSO" link.

Tests: 5 new test files (40 tests). setup.test.ts (11), disconnect.test.ts (6), webhook.test.ts (6), client.test.ts (6), sso-privilege.test.ts (11 — REVOKE/GRANT, SECURITY DEFINER, schema-qualified refs, claim/lease/complete columns, lifecycle handlers). Stub extensions for `record_sso_setup_initiated`, `apply_workos_event`, `disable_sso_connection` RPCs + `processed_workos_events` table behavior.

## 6.3.0-pre.9 (2026-05-08)

**v7.0 Phase 5.3 — Org switcher.** Replaces the "first admin/owner membership" hack across `/dashboard` + `/dashboard/admin/*` with a real org switcher backed by an HTTP-only cookie.

- New: `POST /api/dashboard/active-org` sets `cao_active_org` cookie (HttpOnly Secure SameSite=Lax 14d). Body `{ orgId }` validates caller is active member; `{ orgId: null }` clears.
- New: `lib/dashboard/active-org.ts` exports `resolveActiveOrg(svc, userId)` (cookie → first-membership fallback) and `listActiveOrgs(svc, userId)` (with names + roles).
- New: `<OrgSwitcher>` client component in dashboard sidebar (only shows when caller has 2+ active memberships).
- Modified: `/dashboard/layout.tsx`, `/dashboard/page.tsx`, `/dashboard/billing/page.tsx`, `/dashboard/admin/layout.tsx` all now consult `resolveActiveOrg` instead of `memberships[0]`.
- Admin layout cookie restricted to admin/owner orgs — cannot escalate a member-only org into the admin surface.
- 11 new tests (6 backend route + 5 helper). Stale-cookie test asserts the membership check rejects removed members.
- No new env vars, no migration.

## 6.3.0-pre.8 (2026-05-08)

**v7.0 Phase 5.2 — Audit log viewer + cost reporting (CSV export).** Closes the audit half of the original Phase 5 scope.

New surfaces:
1. `/dashboard/admin/audit` — server-rendered, role-gated. Paginated audit log with single-action filter, cursor-based pagination, prev_hash/this_hash exposed for chain-replay debugging.
2. `/dashboard/admin/cost` — owner/admin only. Per-user cost breakdown for a YYYY-MM period, default current UTC month. Download CSV button.

3 new API routes (all under `/api/dashboard/orgs/:orgId/`):
- `GET /audit` — list_audit_events RPC; cursor decode + ISO since/until validation route-side; nextCursor base64-re-encoded
- `GET /cost` — org_cost_report RPC; period response normalized to `{ since, until, sinceTs, untilTs }`
- `GET /cost.csv` — same RPC, formats as RFC 4180 CSV (CRLF, UTF-8 no BOM, double-quote escape); filename `cost-<orgId>-<since>-<until>.csv` (no org-name interpolation)

2 SECURITY DEFINER Postgres RPCs in `data/deltas/20260508160000_phase5_2_audit_cost_rpcs.sql`:
- `list_audit_events` — keyset pagination on `(occurred_at DESC, id DESC)` with index `audit_events_org_keyset_idx`. LEFT JOIN auth.users for actor_email.
- `org_cost_report` — aggregates runs by user_id; coalesce-in-coalesce-out NULL safety; LEFT JOIN auth.users.
- Both `SECURITY DEFINER SET search_path = public, audit, auth, pg_temp`. `REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO service_role` only.

3 new helpers:
- `lib/dashboard/period.ts` — YYYY-MM parser converting `since/until` to (sinceTs, untilTs exclusive). UTC. Default to current month when both null.
- `lib/dashboard/cost-csv.ts` — RFC 4180 encoder + safe filename builder (validates against `[a-zA-Z0-9._-]`).
- `lib/dashboard/audit-cursor.ts` — base64 JSON cursor encode/decode + ISO 8601 UTC validator.

Codex passes folded:
- Spec pass 1 (3 CRITICAL: cost period semantics, runs.created_at vs nonexistent occurred_at, CSV filename injection + 7 WARNING + 2 NOTE)
- Spec pass 2 (2 CRITICAL: filename surface contradiction, deployment target clarification + 7 WARNING: cursor validation in route, error contract, JSON shape unification, audit period parsing, cache headers + 2 NOTE)
- Plan pass (2 CRITICAL: schema-qualify audit.events + SET search_path lock, runs.cost_usd ordering guard + 6 WARNING)

All routes return `Cache-Control: private, no-store`. All pages declare `force-dynamic`.

39 new tests (Phase 5.1's 237 → **276 web tests**). Helper unit tests: 21. Backend route tests: 32. Integration: 4. Privilege: 7 (incl. SECURITY DEFINER + search_path + schema-qualification + Phase 4 dependency check).

**Operator follow-up:** run `/migrate` to apply `20260508160000_phase5_2_audit_cost_rpcs.sql` against dev → QA → prod.

## 6.3.0-pre.7 (2026-05-08)

**v7.0 Phase 5.1 — Members management + RBAC enforcement.** First Org-tier user-visible surface. After Phase 5.1 ships, an Org-tier admin (small/mid Stripe plans, or free org owner) can actually manage their team.

New surfaces:
1. `/dashboard/admin/members` — server-rendered, role-gated. Lists active members with email, role dropdown per row, remove button. Embedded invite form (email + role).
2. `/dashboard/admin/settings` — owner-only. Edit org name (1..100 chars).
3. `/dashboard/admin/layout.tsx` — sidebar nav. 404s if signed-out OR caller has no admin/owner membership in any org.
4. Sidebar "Admin" link in `/dashboard/layout.tsx` — visible only when caller has admin/owner membership somewhere.

5 new API routes (all under `/api/dashboard/orgs/`):
- `GET /:orgId/members` — list active members + emails.
- `POST /:orgId/members/invite` — admin/owner invites by email; reactivates removed members.
- `PATCH /:orgId/members/:userId` — change role (matrix-gated).
- `DELETE /:orgId/members/:userId` — soft-remove (admin: members only; owner: any).
- `PATCH /:orgId` — owner updates org name.

4 SECURITY DEFINER Postgres RPCs in `data/deltas/20260508140000_phase5_1_member_rpcs.sql`:
- `invite_member`, `change_member_role`, `remove_member`, `update_org_name`.
- Each acquires `FOR UPDATE` lock on `memberships` rows for the org BEFORE re-reading caller role + authorizing. Atomically count + write + audit.append in one transaction.
- `REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO service_role;` — direct authenticated RPC calls fail with `42501 permission denied`.
- Codex pass 1 CRITICAL (TOCTOU last-owner race) + codex pass 2 CRITICAL (caller-spoofing + lock-before-authorize) + codex plan-pass CRITICAL (`update_org_name` NULL-role guard) — all folded.

CSRF: `assertSameOrigin(req)` on every mutating route (5 of 5).

Audit events: `org.member.invited`, `org.member.role_changed`, `org.member.removed`, `org.settings.updated`. Written by RPCs only — never in route code.

35 backend tests + 4 integration tests = 39 new web tests. Existing 180 still pass. Concurrency test (#31) proves serial last-owner check via stub mutex; static migration test (#31b) proves REVOKE/GRANT.

No new env vars. No CLI changes.

**Operator follow-up:** run `/migrate` to apply `20260508140000_phase5_1_member_rpcs.sql` against dev → QA → prod.

## 6.3.0-pre.6 (2026-05-08)

**v7.0 Phase 4 — Free tier dashboard UI + `/cli-auth` page + public share-by-URL.** Closes the loop on Phase 3's commercially load-bearing 402: free users now SEE "you've used 87/100 this month" and one click away from upgrading.

Eight new UI surfaces:
1. `/dashboard` overview — auth-gated, server-rendered. Run count this month, cost MTD, current plan, recent runs (5), 30-day cost chart (inline SVG, no library).
2. `/dashboard/runs` — paginated list (20/page, offset-based via `range()`).
3. `/dashboard/runs/[runId]` — detail page with manifest-driven event replay (lazy chunk loading, hard 1000-event cap for MVP), state inspector, cost breakdown, visibility toggle.
4. `/dashboard/billing` — current plan/caps/usage; Upgrade/Manage subscription buttons that POST to Phase 3 endpoints.
5. `/dashboard/billing/success` — post-checkout polling page.
6. `/cli-auth` (DEFERRED FROM 2.3) — completes the CLI dashboard login flow. Server-validates `cb` (loopback only, port 56000-56050) + `nonce` (32 hex). Authenticated user clicks "Sign in CLI" → mints API key via `/api/dashboard/api-keys/mint` → POSTs to loopback with `mode: 'cors'`. CLI loopback listener (Phase 2.3, EXTENDED) gains OPTIONS preflight + `Access-Control-Allow-Origin` matching the configured `AUTOPILOT_PUBLIC_BASE_URL`.
7. `/runs/[runShareId]` — public share-by-URL. Server-side anon Supabase client (NOT createBrowserClient). Read-only events replay + state.
8. `PATCH /api/dashboard/runs/:runId/visibility` — narrow owner-only endpoint with explicit owner check + assertSameOrigin guard. NOT direct UPDATE on runs from client.

Plus required infrastructure:
- **Authorized signed-URL minter** at `GET /api/dashboard/runs/:runId/artifact?kind=manifest|chunk|state[&seq=N]` — verifies owner OR `visibility='public'` BEFORE calling `storage.from('run-uploads').createSignedUrl(path, 60)`. Bucket stays fully private. Chunk seq bounded against `upload_session_chunks` count → 422 on out-of-range. Path derived ONLY from DB-trusted values via `chunkPath()` helper.
- **assertSameOrigin guard** on cookie-authenticated mutating routes (mint, revoke, visibility, checkout, portal). Compares `Origin` header against `loadPublicBillingConfig().AUTOPILOT_PUBLIC_BASE_URL`. Skipped when API-key bearer auth is used.
- **`/cli-auth` security headers via middleware** — `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and CSP including exact `connect-src 'self' http://127.0.0.1:* http://localhost:*` for the loopback POST. Headers set in middleware.ts (Server Component `headers()` reads request, not response).
- **Finalize handler** persists sanitized `cost_usd`/`duration_ms`/`run_status` from CLI state.json. TS-side bounds + enum validation BEFORE DB UPDATE so a buggy CLI doesn't trip the new CHECK and bring down the whole UPDATE. Wrapped in try/catch for graceful degradation during the rollout window before `/migrate` applies the new columns. Display-only — labeled "Reported by CLI", no entitlement/billing logic reads them.
- **safeRedirect** allowlist accepts `/cli-auth` AND preserves the full `?cb=&nonce=` query string when bouncing through Supabase Auth.
- **Env unification** — `AUTOPILOT_PUBLIC_BASE_URL` is now the canonical name everywhere (web AND CLI). The CLI's older `AUTOPILOT_DASHBOARD_BASE_URL` is a deprecated alias (warn-once on use).

Component breakdown: `<RunListItem>` server, `<EventReplay>` client (manifest-driven, lazy chunks, 1000-event cap), `<StateInspector>` client (recursive tree, no JSON-tree library), `<CostChart>` server (inline SVG, ~80 LOC), `<PlanCard>` server with client `<UpgradeButtons>`/`<ManageSubscriptionButton>`, `<VisibilityToggle>` client (optimistic update + confirmation modal).

30+ new tests: 6 visibility (incl. CSRF) + 14 artifact (9 base + 3 RLS + 2 seq-bounds) + 1 finalize-persists + 9 sanitize + 1 finalize-malformed-status + 3 cli-auth validate + 4 cli-auth headers + 1 cli-auth redirect round-trip + 2 cost-chart + 6 dashboard-pages integration + 4 origin-mismatch (mint/revoke/checkout/portal) + 1 CLI OPTIONS preflight = ~52 added tests across web + CLI.

**Migration:** `data/deltas/20260508120000_phase4_runs_metadata.sql` — `runs.cost_usd NUMERIC(12,4)`, `duration_ms INTEGER`, `run_status TEXT` with CHECK enum; cost-chart partial indexes (user vs org); `runs_select_public` policy for anon/authenticated on `visibility='public'`; column-level GRANT to anon (only safe public columns, NOT `SELECT *`). Operator runs `/migrate` post-merge BEFORE the code deploy fully exercises the new columns; finalize handler graceful-drops if columns missing.

**No new env vars** — all reuse Phase 2.1 + 2.3 + 3 vars. Consider standardizing `AUTOPILOT_PUBLIC_BASE_URL` in any custom CLI deployments (Phase 2.3's `AUTOPILOT_DASHBOARD_BASE_URL` still works but logs deprecation warning).

**Operator follow-ups:**
- Run `/migrate` to apply `data/deltas/20260508120000_phase4_runs_metadata.sql`.
- (Optional) Configure Stripe Customer Portal in dashboard if not already (allows cancellation, payment update from `/dashboard/billing`).

## 6.3.0-pre.5 (2026-05-08)

**v7.0 Phase 3 — Stripe entitlement enforcement.** Makes the cryptographic credibility boundary commercially load-bearing: every engine-on `autopilot --mode full` upload is now gated on the org's monthly run cap and retained-storage cap.

Five new surfaces:
1. `POST /api/stripe/webhook` — `runtime='nodejs'`, raw-body signature verification, claim/lease/complete idempotency (status='processing' + locked_until+attempt_count, stale leases reclaimed atomically), `last_stripe_event_at` watermark for out-of-order delivery. Handles `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`.
2. `POST /api/dashboard/billing/checkout` — Supabase session auth with role check (owner/admin), Stripe Checkout Session create with `idempotencyKey='${orgId}:${tier}:${interval}'` and customer reuse via `billing_customers.stripe_customer_id`. Returns `{ url }`.
3. `POST /api/dashboard/billing/portal` — same auth, returns Stripe Customer Portal session URL.
4. `POST /api/upload-session` — Phase 2.2 endpoint extended with entitlement gate between ownership pass and JWT mint. Returns 402 `{ error: 'limit_reached', limit, current, max, upgrade_url }`. New body field `expectedBytes` from `fs.stat(events.ndjson).size` for storage cap preflight (catches the 4.9-of-5GiB user uploading 20GiB pattern).
5. CLI uploader catches 402 → throws typed `UploadLimitError`. Auto-upload entry point (`auto-upload.ts`) detects, prints friendly message, returns `reason='limit-reached'` without bubbling. Run's exit code preserved.

Pricing tiers (per v7.0 MVP): Free (100 runs/mo, 5 GiB, $0), Org Small (1000, 50 GiB, $99/mo or $990/yr), Org Mid (10000, 500 GiB, $499/mo or $4990/yr), Enterprise (NULL caps = no enforcement, sales-led). PLAN_MAP keys by `(tier, interval)` for all 4 price IDs. Free organizations DO exist and share an org-level cap (NOT each-user-gets-personal-cap) — seeded by AFTER INSERT trigger on `organizations`.

Run-count cap uses STRICT `>` comparison (the runs row already exists when /api/upload-session is called, so count=100 is the 100th and is allowed; reject only at 101+). Storage cap = `sum_retained_bytes(orgId, userId, 90 days)` SQL aggregate, with `expectedBytes` preflight at mint time.

`loadBillingConfig()` validates Stripe env at runtime with zod; `loadPublicBillingConfig()` only reads `AUTOPILOT_PUBLIC_BASE_URL` so missing Stripe env doesn't break the upload-session entitlement gate. Subscription state grace logic: canceled-and-past-period-end → free; cancel_at past → free; payment_failed_at older than 7 days → free.

31 new tests: 8 webhook + 4 checkout + 3 portal + 10 checkEntitlement + 2 plan-map + 2 upload-session integration (web) + 3 CLI 402 handling.

**Migration:** `data/deltas/20260507180000_phase3_billing.sql` — `billing_customers`, augments `entitlements` with Stripe state + caps + watermark, `stripe_webhook_events` with claim/lease, `personal_entitlements`, augments `runs` with `total_bytes`+`deleted_at`, `sum_retained_bytes` + `count_runs_this_month` + `seed_free_entitlements` SECURITY DEFINER RPCs/trigger. CHECK constraint enforces free/small/mid have explicit caps and enterprise has NULLs. Backfills existing rows BEFORE adding the constraint. Operator runs `/migrate` post-merge.

**New env vars (Vercel):**
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_SMALL_MONTHLY`
- `STRIPE_PRICE_SMALL_YEARLY`
- `STRIPE_PRICE_MID_MONTHLY`
- `STRIPE_PRICE_MID_YEARLY`

**Operator follow-ups:**
- Run `/migrate` to apply the migration through dev → QA → prod.
- Set the 6 Stripe env vars above in Vercel.
- Configure Stripe webhook in dashboard pointing at `https://autopilot.dev/api/stripe/webhook` and subscribe to: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`.
- Create Stripe Products + 4 Prices: small ($99/mo + $990/yr), mid ($499/mo + $4990/yr).

## 6.3.0-pre.4 (2026-05-07)

**v7.0 Phase 2.3 — CLI dashboard verbs + auto-upload at run.complete.** Connects v6.x autopilot pipeline to Phase 2.2's ingest API.

Four new CLI verbs: `claude-autopilot dashboard {login,logout,status,upload}`. After `dashboard login`, every engine-on `autopilot --mode full` automatically uploads to autopilot.dev when `run.complete` fires. Login flow uses 128-bit nonce-bound loopback HTTP listener (port 56000-56050) with strict server-side `callbackUrl` validation, `crypto.timingSafeEqual` nonce verify, and atomic config write at `~/.claude-autopilot/dashboard.json` (mode 0600, dir 0700). Snapshot-before-upload (events.ndjson + state.json copied to `<runDir>/.upload-snapshot/` with stat-before/stat-after defense) so streaming writers can't tear the chunk reads. Auto-upload is foreground await with SIGINT/AbortController; failure prints `claude-autopilot dashboard upload <runId>` resume command and never overrides the run's exit code. Empty events.ndjson skips upload cleanly. Opt out per-run with `--no-upload` or globally with `CLAUDE_AUTOPILOT_UPLOAD=off`.

Web side adds four new endpoints under `/api/dashboard/`: `POST api-keys/mint` (Supabase session auth → atomic `mint_api_key_with_nonce` RPC, 128-bit `clp_<64-hex>` keys, SHA256-hashed at rest, 12-char prefix display), `POST api-keys/revoke` (idempotent, ownership-scoped), `GET me` (memberships + lastUploadAt), `GET runs/:runId/upload-session` (resume in-flight session). Centralized `authViaApiKey()` helper in `apps/web/lib/dashboard/auth.ts` looks up keys by deterministic hash with `eq + maybeSingle` (O(1)) and filters revoked keys. Strict `validateCallbackUrl()` regex restricts callbacks to `http://(127.0.0.1|localhost):560(0[0-9]|[1-4][0-9]|50)/cli-callback` with double-parse defense.

CLI ↔ web parity guaranteed by shared fixtures: `apps/web/lib/upload/__fixtures__/{chain-vectors,state-canonicalization-vectors}.json` are loaded byte-for-byte by `tests/dashboard/parity.test.ts`. Identical chain-root and JCS-canonical sha256 in both directions.

**Migration:** `data/deltas/20260507120000_phase2_3_api_keys.sql` — adds `api_keys` (RLS, key_hash regex check, prefix_display regex check), `api_key_mint_nonces` (RLS, service-role-only), `expire_mint_nonces()` SECURITY DEFINER RPC, and the atomic `mint_api_key_with_nonce()` SECURITY DEFINER RPC that fuses sweep + dedup-check + insert key + insert nonce in a single transaction. Operator runs `/migrate` post-merge.

**New env vars:**
- Web (Vercel): `NEXT_PUBLIC_AUTOPILOT_BASE_URL` — used by the `cli-auth` web page (deferred to Phase 4 dashboard UI) to display loopback callback URL.
- CLI: `AUTOPILOT_DASHBOARD_BASE_URL` (defaults `https://autopilot.dev`); `CLAUDE_AUTOPILOT_HOME` (defaults `~/.claude-autopilot`); `CLAUDE_AUTOPILOT_UPLOAD=off` opts out of auto-upload; `CLAUDE_AUTOPILOT_UPLOAD_RETRY_MS` overrides retry backoff (test seam).

**Operator follow-ups:**
- Run `/migrate` to apply the migration through dev → QA → prod.
- Set `NEXT_PUBLIC_AUTOPILOT_BASE_URL=https://autopilot.dev` in Vercel.
- Implement the `/cli-auth` web page in Phase 4 dashboard UI. The page must mint via `POST /api/dashboard/api-keys/mint` then POST `{ apiKey, fingerprint, accountEmail, nonce }` to the loopback callback (URL passed in `?cb=`). Phase 2.3 tests use a mock handler that simulates this flow end-to-end.

## 6.3.0-pre.3 (2026-05-07)

**v7.0 Phase 2.2 — ingest API + tamper-evident events.** First server endpoints in the repo. Three routes (`POST /api/upload-session`, `PUT /api/runs/:runId/events/:seq`, `POST /api/runs/:runId/finalize`) implement signed-session uploads with hash-chain verification and idempotent finalize. Per-chunk immutable Storage objects, DB row lock + unique constraint + Storage `upsert: false` triple-defense against concurrent corruption. Two-phase write ordering with `upload_session_chunks.status` for crash recovery. Dedicated `UPLOAD_SESSION_JWT_SECRET` (HS256, 15-min TTL, full claim hardening). RFC 8785 (JCS) state canonicalization. 38 new tests across upload-session, events-chunk, finalize, hash-chain vectors, JCS vectors, JWT, and storage helpers.

**Migration:** `data/deltas/20260507000000_phase2_2_ingest.sql` — adds `upload_session_chunks` table, augments `upload_sessions` with `next_expected_seq` + `chain_tip_hash`, adds `runs.state_sha256` + `runs.events_index_path`, partial unique index on `upload_sessions(run_id) WHERE consumed_at IS NULL`, CHECK constraints on hash-format columns, plus `claim_chunk_slot` and `mark_chunk_persisted` SECURITY DEFINER RPCs. Operator runs via `/migrate` post-merge.

**New env var:** `UPLOAD_SESSION_JWT_SECRET` — set in Vercel + local `.env.local`. Generate with `openssl rand -hex 32`. NOT shared with `SUPABASE_JWT_SECRET`.

**Storage bucket:** `run-uploads` — operator one-time setup in the Supabase project (private; service-role-only writes).

## 6.3.0-pre.2 (2026-05-07)

**v7.0 Phase 2.1 — Next.js scaffold + Supabase Auth (Free tier sign-in).**

First sub-PR of v7.0 Phase 2 (Ingest API + CLI integration). Pure foundation; no API endpoints related to ingest, no CLI dashboard verbs.

**What landed:**
- `apps/web/` Next.js 16 App Router app with React 19 + Tailwind v4
- npm workspaces (`workspaces: ["apps/*", "packages/*"]`) — CLI deps stay where they are; web deps live in `apps/web/package.json`
- `tsconfig.base.json` shared between CLI and web; `apps/web/` uses `bundler` module resolution, CLI keeps `NodeNext`
- Supabase Auth Google sign-in via PKCE callback (`/api/auth/callback`)
- Sign-out (`/api/auth/sign-out`) clears only configured project ref's cookies — never `sb-*` wildcard
- `safeRedirect` whitelist with documented change policy
- Scoped middleware matcher: refreshes session on page + `/api/auth/*` routes ONLY; excludes static assets, `/api/health`, and non-auth `/api/*` (ingest endpoints in 2.2 handle their own auth)
- Health endpoint `/api/health` for platform health checks
- 22 web tests via Vitest (10 redirect + 5 callback + 2 signout + 4 matcher + 1 typecheck-guard)
- `web-tests.yml` workflow runs typecheck + Next.js build + tests on every PR
- `npm-tarball-check.yml` workflow asserts `apps/` is excluded from the published CLI tarball
- `vercel.json` configured for monorepo build with `apps/web/` root

**Spec:** `docs/specs/v7.0-phase2.1-nextjs-scaffold.md` (PR #116)
**Plan:** `docs/superpowers/plans/2026-05-07-v7.0-phase2.1-nextjs-scaffold.md`

Pre-release on the npm `next` tag. `latest` stays on `6.2.2`.

## 6.3.0-pre.1 (2026-05-07)

**v7.0 Phase 1 — Foundation: schema + RLS + cross-tenant negative tests.**

First step toward the v7.0 hosted product. Database-only PR; no endpoints, no UI, no Stripe integration.

**What landed:**

- `db/supabase/` Supabase project bootstrap with 8 numbered migrations
- 7 multi-tenant tables: `organizations`, `memberships`, `runs`, `upload_sessions`, `entitlements`, `audit_events`, `organization_settings`
- RLS enabled on every table with two-branch pattern: `(organization_id IS NOT NULL AND active member)` OR `(organization_id IS NULL AND user_id = auth.uid())`
- `audit.append()` SQL function with hash-chain immutability; app roles get INSERT only via the function
- Supabase Storage buckets `org-runs` and `user-runs` with tenant-scoped path-prefix RLS
- `entitlements.plan` CHECK constraint matching `organizations.plan` exactly
- `upload_sessions` stores only `jti` + token hash (never raw signing material)
- 7 RLS negative test files covering: runs cross-tenant, free-vs-org-tier branches, audit immutability, storage path isolation, entitlements admin-only, membership edge cases, upload_sessions single-use
- CI workflow `.github/workflows/db-tests.yml` runs the test suite against a Dockerized Supabase on every PR

**Spec:** `docs/specs/v7.0-hosted-product-mvp.md` (PR #114)
**Plan:** `docs/superpowers/plans/2026-05-07-v7.0-phase1-foundation.md`

Pre-release on the npm `next` tag. `latest` stays on `6.2.2`.

## 6.2.2 — `claude-autopilot autopilot --json` envelope + cache version policy (2026-05-07)

**Headline.** Closes out the v6.2.x track. `claude-autopilot autopilot --json` now emits exactly one machine-readable envelope on stdout — successful runs, pre-run failures, and mid-pipeline failures all produce the same shape so CI consumers can branch on `.exitCode` / `.failedPhase` / `.errorCode` directly without parsing stderr NDJSON. The cache contract gains a `MIN_SUPPORTED..MAX_SUPPORTED` schema-version window so a stale run dir from a future binary fails with a clear error instead of an opaque shape crash. The migration guide gets a new "v6.1 → v6.2: one runId across the pipeline" section.

**Motivation — Codex review of the v6.2 spec (3 WARNING + 3 NOTE).** The v6.2 orchestrator spec reserved `--json` for v6.2.2; the spec for this PR (Codex 5.3-reviewed) folded back three warnings (strict equality on schemaVersion blocks rolling deploys, exactly-once envelope needs uncaughtException coverage, exit-code taxonomy ambiguous for pre-run failures) and three notes (six-phases vs four-phases migration text, `errorCode` union too loose, stdout purity test under stderr load).

**What's in (the 9 deliverables from the spec's "Scope" section).**

- **Outer JSON envelope** for `claude-autopilot autopilot --json`. New `AutopilotJsonEnvelope` shape (`version: '1'`, `verb: 'autopilot'`, `runId | null`, `status`, `exitCode`, `phases[]`, `totalCostUSD`, `durationMs`, `errorCode?`, `errorMessage?`, `failedAtPhase?`, `failedPhaseName?`). Pre-run failures get `runId: null` + populated `errorCode`. Mid-pipeline failures get `failedAtPhase` + `failedPhaseName`.
- **Bounded `AutopilotErrorCode` enum.** Exact strings: `invalid_config | budget_exceeded | lock_held | corrupted_state | partial_write | needs_human | phase_failed | internal_error`. CI consumers can rely on these specific values; new codes ship as minor versions of the envelope schema. Per codex NOTE #5.
- **Single-write latch + uncaughtException / unhandledRejection handlers.** Module-scoped boolean in `src/cli/json-envelope.ts` flips BEFORE writing so subsequent calls no-op. The orchestrator's `runAutopilotWithJsonEnvelope` installs process-level fatal handlers that consult the latch — if an envelope already shipped, they exit silently; otherwise they emit a fallback `internal_error` envelope before exiting `1`. Test seam `__testInstallProcessHandlers: false` keeps the handlers from leaking across the suite. Per codex WARNING #2.
- **Deterministic exit-code-to-errorCode mapping** via `computeAutopilotExitCode`. `0` success / `1` `invalid_config | phase_failed | internal_error` / `2` `lock_held | corrupted_state | partial_write` / `78` `budget_exceeded | needs_human`. Per codex WARNING #3.
- **Cache contract version policy** in `src/core/run-state/state.ts` + the replay path in `events.ts`. New exports `RUN_STATE_MIN_SUPPORTED_SCHEMA_VERSION = 1` and `RUN_STATE_MAX_SUPPORTED_SCHEMA_VERSION = RUN_STATE_SCHEMA_VERSION`. `replayState()` throws `corrupted_state` when the persisted `schema_version` falls outside the window, with a message naming both bounds for operator triage. Future minor versions can additively expand the schema while preserving forward-read compatibility (bump writer, leave reader); major bumps reset `MIN_SUPPORTED` to break with the past explicitly. Per codex WARNING #1.
- **Migration guide section.** New "v6.1 → v6.2: one runId across the pipeline" section in `docs/v6/migration-guide.md` walks through the per-verb → orchestrator collapse, the `--json` envelope shape (success / pre-run failure / mid-pipeline failure examples), the `AutopilotErrorCode` taxonomy table, and the cache version policy. Flags the v6.2.0 vs v6.2.1 phase-set difference per codex NOTE #4 — examples assume the v6.2.1 6-phase set (`scan → spec → plan → implement → migrate → pr`).
- **Channel discipline preserved.** The envelope is the only thing on stdout in `--json` mode (orchestrator runs with `__silent: true`). NDJSON events continue to flow to stderr unchanged via the existing v6 Phase 5 helpers.
- **Dispatcher wiring.** `src/cli/index.ts` plumbs `--json` through to `runAutopilotWithJsonEnvelope`; pre-run validation failures (`--mode`, `--budget`) emit envelopes too so CI never sees free-text errors when `--json` is on.

**Tests.** Baseline 1534 → 1548 (+14 net new):

- 9 envelope tests in `tests/cli/autopilot-json-envelope.test.ts` covering the 6 spec scenarios (success, pre-run failure, mid-pipeline failure, no-ANSI on stdout, stdout purity under stderr load, single-write latch + uncaughtException) plus 1 latch sanity test and 2 exit-code/enum mapping tests.
- 5 schema-version range tests in `tests/run-state/state.test.ts` covering the bounds export plus accept-in-range, reject-below-MIN, reject-above-MAX, and message-names-both-bounds.

**Engine-off path unchanged.** The schema-version range check applies inside `replayState()` (engine-on territory). Engine-off invocations don't read run dirs and are byte-for-byte identical to v6.2.1.

**Out of scope (deliberate, see spec for full list).**
- `--json` envelope on individual wrapped verbs other than `autopilot`. They already emit per-verb envelopes via the v6 Phase 5 helper; no change needed.
- Streaming JSON (newline-delimited progress events on stdout). v6.3 — would need a major channel-discipline change.
- Schema migration tooling. v6.x has only one schema version; migration tooling is reserved for the v7 layout change.

**Spec.** docs/specs/v6.2.2-json-envelope-and-docs.md (3 WARNING + 3 NOTE folded from the Codex 5.3 review).

## 6.2.1 — Side-effect phase idempotency contracts (`migrate` + `pr`) (2026-05-07)

**Headline.** Side-effecting phases now satisfy a registry-enforced two-step contract — record a deterministic "I'm starting this work" breadcrumb BEFORE the side-effect, then one reconciliation ref per durable artifact AFTER. With the contract in place, `migrate` and `pr` enter the orchestrator's `--mode=full` registry, expanding the v6.2.0 `scan → spec → plan → implement` pipeline to the full **6-phase** flow `scan → spec → plan → implement → migrate → pr` under one runId.

**Motivation — Codex CRITICAL gate from v6.2.** The v6.2 orchestrator spec flagged side-effect resume as the riskiest property to certify before adding `migrate` or `pr`: a partial crash mid-dispatch could leave the engine blind to applied work, causing the resume preflight to either silently re-run side effects (data loss) or pessimistically refuse every retry (operability tax). v6.2.1 closes the gap with a uniform contract every side-effecting phase must declare AND a registry-time guard that throws if the declaration is missing.

**What's in (the 7 deliverables from spec section "Scope of THIS PR").**

- **New `migration-batch` ref kind** in `ExternalRefKind` (`src/core/run-state/types.ts`). Documented semantics: "deterministic id covers a planned migration batch; emitted BEFORE dispatch so a partial crash leaves a resume target." Joins `migration-version` (the post-effect reconciliation ref).
- **`migrate` pre-effect breadcrumb.** `src/cli/migrate.ts` now emits a `migration-batch` ref BEFORE `dispatchFn(input)` — a partial crash leaves the orchestrator a resume target. The post-success `migration-version` refs stay (one per applied migration). Per the v6.2.1 spec, the batch id uses the `${env}:pre-dispatch:${Date.now()}` fallback form because no Delegance migrate skill (Supabase, Rails, Alembic, …) exposes its planned set pre-dispatch — the deterministic-id form `sha256(env+plannedMigrations)` is reserved for a follow-up that adds a planning verb to the skill protocol.
- **Provider readback for `migration-batch`** in `src/core/run-state/provider-readback.ts`. Queries the dispatcher's ledger for the planned set + applied set, returns `merged` (all applied), `open` (some pending), `failed` (any errored), or `unknown` (fail closed on missing fetcher / throw / null). New `MigrationBatchFetcher` interface + `registerMigrationBatchFetcher` seam alongside the existing `MigrationStateFetcher`.
- **Registry-time enforcement** in `src/core/run-state/phase-registry.ts`. New `registerPhase()` helper throws `Error: registry: side-effect phase <name> missing idempotency contract` when a `hasSideEffects: true` registration omits `preEffectRefKinds` or `postEffectRefKinds`. Applied to all six entries; the four read-only phases (scan/spec/plan/implement) omit the arrays without complaint.
- **`buildMigratePhase` and `buildPrPhase` builders** extracted following the v6.2.0 builder pattern (scan/spec/plan/implement). Each verb's existing `runX(options)` continues to delegate to its builder — direct CLI behavior is byte-for-byte identical to v6.2.0. The full registry now has: `scan / spec / plan / implement / migrate / pr`.
- **Resume preflight in orchestrator** (`src/cli/autopilot.ts` + new `src/core/run-state/resume-preflight.ts`). Before invoking `runPhase` on any side-effecting phase, the orchestrator collects prior `phase.success` + `phase.externalRef` events from `events.ndjson` and routes per the spec decision matrix: all post-effect refs `merged`/`live` → emit synthetic `phase.success` and skip; pre-effect breadcrumb `open` → retry (the phase body's own ledger handles dedup); otherwise → emit `replay.override` + throw `GuardrailError('needs_human')`. New error code `needs_human` joins the taxonomy in `src/core/errors.ts`.
- **`--mode=full` extended** to 6 phases (`DEFAULT_FULL_PHASES` in `phase-registry.ts`). After v6.2.1, `claude-autopilot autopilot` runs the entire pipeline under one runId — the YC-demo win deferred from v6.2.0.

**Tests.** Baseline 1509 → 1532 (+23 net new):

- 9 gating tests in `tests/cli/autopilot-side-effect-resume.test.ts` covering the 6 spec scenarios (migrate partial-crash retry, migrate full-success skip, pr-open skip, pr-closed needs-human, registry rejection, run-scope budget no-double-charge) plus 3 edge cases (proceed-fresh, prior success without refs, errored-ledger needs-human).
- 8 unit tests in `tests/run-state/provider-readback.test.ts` covering the new `migration-batch` readback (merged / open / failed / empty plan / null fetcher / throw / no fetcher / default-registry routing).
- 2 updated tests in `tests/cli/migrate-engine-smoke.test.ts` to account for the new pre-effect breadcrumb (now `1 + N` refs per run instead of `N`).
- 4 new test variants for the contract guard (`hasSideEffects: true` with each missing array, plus the empty-postEffect / read-only positive cases).

**Engine-off path unchanged.** Existing `migrate`/`pr` invocations without `--engine` continue byte-for-byte identical. The engine-off escape hatch threads through `executeMigratePhase(input, null)` / `executePrPhase(input, null)`, where a null `ctx` makes `emitExternalRef` a no-op — same precedent as every other wrapped verb.

**Out of scope (deliberate, see spec for full list).**
- Deterministic batch id (`sha256(env + plannedMigrations)`) — requires extracting a `planMigrations()` verb from each migrate skill's protocol. v6.2.x follow-up.
- `implement`'s `git-remote-push` ref (declared in the spec table but not yet emitted by `implement.ts`). v6.2.x follow-up.
- Cross-run ref dedup (e.g. recognizing two pre-dispatch breadcrumbs as the same operation across runs). Not needed for orchestrator MVP.
- Provider readback for non-Delegance migrate skills (Rails, Alembic, …). v6.2.1 ships the contract; per-skill readback is per-skill follow-up work.

**Spec.** docs/specs/v6.2.1-side-effect-idempotency.md (Codex CRITICAL gate from v6.2 — folded back as the foundation for this PR).

## 6.2.0 — Multi-phase orchestrator (`claude-autopilot autopilot`) (2026-05-07)

**Headline.** New top-level `claude-autopilot autopilot` verb runs `scan → spec → plan → implement` under **one runId**. The pre-v6.2 chain (`scan && spec && plan && implement`) created four separate runs with no parent — the orchestrator collapses them into a single ledger so `claude-autopilot runs watch <id>` covers the whole pipeline and a `--budget=$25` cap ticks down across phases instead of resetting per verb.

**What's in.**
- **`claude-autopilot autopilot [options]`** — sequential N-phase orchestrator. Engine-on REQUIRED (rejected at pre-flight if `--no-engine` / `CLAUDE_AUTOPILOT_ENGINE=off` / `engine.enabled: false`). Lifecycle: `createRun({ phases })` → per-phase `buildPhase + runPhase` → emit `run.complete` exactly once → refresh state snapshot → release lock in `finally`. Non-interactive (a `pause` budget decision becomes hard-fail) so it works in CI without prompting.
- **`build<Phase>Phase()` builders** extracted from `scan`, `spec`, `plan`, `implement`. Each verb's existing `runX(options)` continues to call its builder internally — direct CLI behavior is byte-for-byte identical to v6.1. Per-verb parity tests (`tests/cli/<verb>-builder-parity.test.ts`) compare stdout / stderr / `events.ndjson` between the legacy entry and the explicit builder + `runPhaseWithLifecycle` path.
- **Phase registry** at `src/core/run-state/phase-registry.ts`. `as const` + per-entry `satisfies PhaseRegistration<I, O>` preserves per-phase I/O typing through dynamic dispatch (per codex review NOTE #5). `getPhase(name)`, `listPhaseNames()`, and `validatePhaseNames(names)` are the public surface; `--phases=<csv>` validation lives here.
- **Run-scope budget** — `BudgetConfig.scope: 'phase' | 'run'` (default `'phase'` for back-compat). When `scope === 'run'` the orchestrator's per-phase budget gates resolve against cross-phase `phase.cost` totals so the `$25` demo narrative ticks down across the whole pipeline. `sumPhaseCost(events, '*')` cross-phase overload added. Both `BudgetCheck.scope` and `BudgetCheckEvent.scope` carry the resolution forward to observers (`runs show <id> --events`, future cost dashboards). Per codex review WARNING #2 — pulled forward into v6.2.0 (was deferred to v6.2.2 in the initial draft).
- **Exit-code matrix** (per codex review WARNING #3) — 0 success, 78 budget_exceeded, 2 engine error (`lock_held` / `corrupted_state` / `partial_write`), 1 everything else. Phase failure wins over finalization error.
- **CLI surface**: `--mode=full` (default — `scan → spec → plan → implement`), `--phases=<csv>` for custom lists, `--budget=<usd>` for the run-scope cap. `--mode=fix` and `--mode=review` reserved for v6.2.1+; `--json` envelope reserved for v6.2.2.

**Tests.** Baseline 1492 → 1509 (+17 new):
- 4 builder-parity tests (`scan`, `spec`, `plan`, `implement`) covering stdout / stderr / events triple-snapshot.
- 6 run-scope budget tests in `tests/run-state/budget.test.ts` covering scope flag default, run-scope happy path, run-scope cap exceeded across phases, Layer 1 advisory in run-scope, and phase/run scope math equivalence (regression guard).
- 7 orchestrator integration tests in `tests/cli/autopilot.test.ts` covering: 3-phase happy path, scan-failure phase 0, run-scope budget exceeded → exit 78, resume lookup `already-complete` short-circuit, `--phases=invalid,scan` → exit 1 invalid_config no run dir, `CLAUDE_AUTOPILOT_ENGINE=off` → exit 1 invalid_config, `cliEngine: false` → exit 1 invalid_config.

**Out of scope (deliberate, see spec for full list).**
- `migrate`, `pr` — gated on per-phase idempotency contracts (preflight readback + externalRef recorded BEFORE side-effect). v6.2.1.
- `--mode=fix`, `--mode=review` — v6.2.1+.
- `--json` envelope — v6.2.2.
- Parallel phase execution. Sequential by design.
- Interactive prompts inside the orchestrator. CI/scripts get deterministic exit codes; pause budget decisions hard-fail.

**Spec.** docs/specs/v6.2-multi-phase-orchestrator.md (Codex-reviewed: 1 CRITICAL + 3 WARNING + 3 NOTE folded back into the spec before implementation).

## 6.1.0 — Default flip: engine on by default + `--no-engine` deprecated (2026-05-07)

**Headline.** The Run State Engine is now ON by default. Bare
`claude-autopilot <verb>` invocations create a `.guardrail-cache/runs/<ulid>/`
directory, emit typed NDJSON events on stderr, apply budget gates if
`budgets:` is configured, and write a state snapshot — without any opt-in
config. v6.0 shipped the engine OFF behind an explicit `engine.enabled: true`
opt-in to give users control during a stabilization window; v6.1 closes
that window.

**Motivation — v6.0 stabilization criteria met.**
- 10 of 10 pipeline phases wrapped through `runPhaseWithLifecycle`
  (`scan` v6.0.1, `costs`/`fix` v6.0.2, `brainstorm`/`spec` v6.0.3,
  `plan`/`review` v6.0.4, `validate` v6.0.5, `implement` v6.0.7,
  `migrate` v6.0.8 — first side-effecting wrap with `migration-version`
  externalRefs, `pr` v6.0.9 — second side-effecting wrap with `github-pr`
  externalRefs).
- Lifecycle helper extracted (v6.0.6) so all 10 wraps share the same
  byte-for-byte engine-on / engine-off behavior.
- Side-effecting wraps proven (`migrate` + `pr`) — externalRef ledger
  + provider readback semantics exercised end-to-end.
- Live adapter cert suite green (Vercel + Fly + Render).
- `runs watch <id>` live cost/budget meter shipped (this release's
  `v6.1.0-pre` entry below) — the YC-demo moment for the events stream.
- `npm test` baseline: 1469 → 1492 (+23 net new this release; all green).

**Deprecation.** `--no-engine`, `CLAUDE_AUTOPILOT_ENGINE=off|false|0|no`,
and `engine.enabled: false` continue to work as the legacy escape hatch
in v6.1.x. Each invocation that resolves to engine-off via one of those
explicit opt-outs now prints a single-line stderr deprecation notice:

```
[deprecation] --no-engine / engine.enabled: false will be removed in v7. Migrate to engine-on (default).
```

The notice fires only on user-driven opt-outs (`source: 'cli' | 'env' |
'config'`); the new (engine-on) default never trips it. **v7 removes
the escape hatch** — `engine.enabled: false` becomes a config validation
error and `--no-engine` / `CLAUDE_AUTOPILOT_ENGINE=off` are silently
ignored.

**Spec.** [`docs/specs/v6.1-default-flip.md`](docs/specs/v6.1-default-flip.md)
is the canonical reference for what flipped, why, and the v7 follow-up.

**Migration tips.**
- If your CI parses stderr as free-form text and relies on the v5.x
  shape, set `CLAUDE_AUTOPILOT_ENGINE=off` (or pass `--no-engine`)
  to pin the legacy behavior. You'll see the deprecation notice on
  every invocation until you remove it — that's expected.
- If you opt out via config (`engine.enabled: false`), the same notice
  fires on every invocation. Plan to remove that line before bumping
  to v7.
- Existing users on `engine.enabled: true` are no-op'd — your config
  still wins via the same precedence rules.
- See [`docs/v6/migration-guide.md#migrating-from-v60-to-v61`](docs/v6/migration-guide.md)
  for the full upgrade walkthrough.

**Test surface.**
- `tests/run-state/resolve-engine.test.ts` — flipped 4 default-related
  cases. New `v6.1 default-flip` describe block + `v6.1 deprecation
  warning` describe block covering the predicate, the emitter, the
  default `process.stderr` branch, and the `builtInDefault` override
  path.
- `tests/run-state/run-phase-with-lifecycle.test.ts` — added 4 new
  cases pinning engine-on as the new default + the deprecation banner
  firing on opt-out / staying silent on the new default.
- 9 engine-smoke tests (`brainstorm`, `costs`, `implement`, `migrate`,
  `plan`, `pr`, `review`, `spec`, `validate`) updated — the
  "engine off (default)" cases are now "engine on (v6.1 default)";
  the matching `cliEngine: false` cases stay as legacy-escape-hatch
  coverage.

**Files changed.**
- `src/core/run-state/resolve-engine.ts` — new active default constant
  `ENGINE_DEFAULT_V6_1 = true`. The deprecated `ENGINE_DEFAULT_V6_0`
  export keeps its historical value (`false`) so out-of-tree consumers
  who pinned that symbol get what the name promises; both constants are
  removed in v7. New `emitEngineOffDeprecationWarning` helper +
  `shouldWarnEngineOffDeprecation` predicate +
  `ENGINE_OFF_DEPRECATION_MESSAGE` stable copy.
- `src/core/run-state/run-phase-with-lifecycle.ts` — wires the
  deprecation helper into the engine-off branch.
- `docs/v6/migration-guide.md` — new "Migrating from v6.0 to v6.1"
  section, updated precedence matrix, refreshed default-flip plan,
  relabeled "What changes" table.
- `README.md` — v6 section updated (engine on by default + v7 removal
  timeline).
- `package.json` — version `5.5.2` → `6.1.0`.

## v6.1.0-pre — `runs watch <id>` live cost meter (2026-05-07)

**The YC-demo moment.** v6.0.x hardened the events.ndjson stream across
all 10 wrapped phases; v6.1 makes that stream visible in real time.
`runs watch <runId>` tails events.ndjson via `fs.watchFile` (1s poll —
inotify/FSEvents are unreliable for tiny appends across our matrix) and
pretty-renders each event with a running cost/budget meter so a user
running `claude-autopilot autopilot ...` in one terminal can `runs watch`
in another and watch their $25 budget tick down while phases ship code.

**Demo transcript.** Live tail of a fixture run, ANSI-stripped:

```
* run 01HZK7P3D8Q9V00000000000AB
  phases: spec -> plan -> implement -> pr
  budget: $0.00 / $25.00 (0%)
[12:00:01] phase.start         spec
[12:00:42] phase.cost          spec           +$0.07  (in: 1.2k, out: 3.4k)  total: $0.07
[12:00:45] phase.success       spec           OK 44.2s
[12:00:46] phase.start         plan
[12:01:12] phase.cost          plan           +$0.21  (in: 4.1k, out: 8.2k)  total: $0.28
[12:01:15] phase.success       plan           OK 29.0s
[12:08:33] phase.externalRef   pr             -> github-pr#123
[12:08:34] run.complete        status=success  totalCostUSD=$4.20  duration=8m32s

done  run 01HZK7P3D8Q9V00000000000AB
  status=success  totalCostUSD=$4.20  duration=8m33s
```

**Modes.**

- `runs watch <id>` — live tail, exits on `run.complete` / Ctrl-C
- `runs watch <id> --since <seq>` — replay forward from a specific seq
  (resume after disconnect)
- `runs watch <id> --no-follow` — render snapshot once and exit (CI /
  scripting)
- `runs watch <id> --json` — emit raw NDJSON to stdout (one event per
  line) for piping to `jq` or external dashboards. ANSI suppressed.
- `runs watch <id> --no-color` — force ANSI off even on a TTY

**Pretty rendering.** Color thresholds on the budget bar — green <50%,
yellow 50-90%, red >90%. Per-event coloring: cyan for phase.start, yellow
for phase.cost, green for phase.success, red for phase.failed, magenta
for phase.externalRef + lock.takeover + replay.override, bold-green for
run.complete success, bold-red for run.complete failed/aborted. ANSI
auto-strips when stdout is not a TTY (CI), when `--no-color` or `--json`
is set, or when `NO_COLOR` env var is present.

**Pure renderer.** `src/cli/runs-watch-renderer.ts` is referentially
transparent — `renderEventLine(event, runningTotal, opts)` is the core
primitive, exported and 100% pure. Tests run as string-equality
assertions in <300ms.

**Engine modules untouched.** This is purely a consumer of the existing
event stream — no changes to `src/core/run-state/**`, no changes to the
10 wrapped phase verbs, no changes to `runPhaseWithLifecycle`.

**Tests.** +43 new tests:
- `tests/cli/runs-watch-renderer.test.ts` — 29 pure-renderer cases
  covering every event-line variant, the three budget-bar color
  thresholds, ANSI on/off symmetry, and the final-summary block
- `tests/cli/runs-watch.test.ts` — 14 verb-level cases covering
  `--no-follow` snapshot, `--since` replay, `--json` mode, run-not-found
  (exit 2), invalid-ULID, live tail picks up appended events,
  budget rendering with/without `BudgetConfig`, plural `budgets` config
  alias, ANSI behavior, and run-complete short-circuit on already-
  terminated runs

**CLI plumbing.** New sub-verb on the `runs` umbrella: `runs watch <id>`.
Help block surfaces `--since`, `--no-follow`, `--json`, `--no-color`
plus a behavior summary + exit-code key. Exit codes: 0 success / clean
exit, 1 invalid input or stream error, 2 not_found.

## v6.0.9 — wrap `pr` through `runPhaseWithLifecycle` (2026-05-06)

**First side-effecting phase wrapped.** v6.0.1 → v6.0.5 wrapped read-only
verbs (`scan`, `costs`, `fix`, `brainstorm`, `spec`, `plan`, `review`,
`validate`); v6.0.6 extracted the lifecycle helper. v6.0.9 wraps `pr` —
the first verb that mutates state on the platform of record (GitHub
issue comments + PR reviews). This proves the helper's `ctx.emitExternalRef`
plumbing for genuinely side-effecting phases without any helper-shape
changes.

**Declarations.** Match the v6 spec table exactly:

- `idempotent: false` — re-running posts a NEW PR review ID each time
  (`postReviewComments` dismisses prior + creates new). PR comment
  posting (`postPrComment`) is marker-deduped on the body but the
  underlying `gh` API call is still mutating.
- `hasSideEffects: true` — posts to GitHub via the `gh` CLI inside the
  inner `runCommand` invocation.
- `externalRefs: github-pr` — recorded BEFORE the inner `runCommand`
  runs so a crash mid-pipeline still leaves a breadcrumb pointing at
  the PR. The engine path's Phase 6 resume logic can `gh pr view <id>`
  to confirm the PR is still open before deciding whether a replay
  is safe.

**Engine-off byte-for-byte unchanged.** All `gh pr view` + `git fetch` +
`runCommand` behavior preserved. The wrap adds two test seams
(`__testPrMeta` to short-circuit PR metadata lookup, `__testRunCommand`
to stub the inner pipeline) so the smoke test exercises the engine
lifecycle without `gh` or a real review pipeline. Production callers
must not pass these — they're documented "test only" with a comment
mirroring scan / fix's `__testReviewEngine` precedent.

**CLI plumbing.** The `pr` dispatcher arm now threads `cliEngine` from
`parseEngineCliFlag()` and `envEngine` from
`process.env.CLAUDE_AUTOPILOT_ENGINE`, mirroring every other wrapped
verb. The per-verb help block (`claude-autopilot help pr`) gains
`--engine` / `--no-engine` lines plus a side-effects note (engine-on
records a `github-pr` externalRef; future replays gate on the spec's
"side-effect readback" rule). `GLOBAL_FLAGS_BLOCK` adds "v6.0.9: wired
for `pr`" to its breadcrumb list.

**Smoke test.** New `tests/cli/pr-engine-smoke.test.ts`, 6 cases:
- engine off (default): no run dir / no engine artifacts; runCommand
  still invoked
- engine off (`cliEngine: false`): no run dir
- engine on (`--engine`): state.json + events.ndjson + lifecycle in
  order (run.start → phase.start → phase.externalRef → phase.success
  → run.complete); externalRef recorded with kind=`github-pr`,
  id=`42`, provider=`github`; `idempotent: false, hasSideEffects: true`
  reflected on the phase
- env precedence (`CLAUDE_AUTOPILOT_ENGINE=on` without CLI flag)
- CLI override (`--no-engine` beats env on)
- runCommand returning 1 surfaces as verb exit 1 WITHOUT marking the
  engine phase as failed (pipeline result ≠ phase failure, same
  precedent as scan)

**Why no follow-up `github-comment` externalRef yet.** A potential
extension is to record one externalRef per posted comment / review
(`github-comment`). That requires plumbing the post-comment URL out
of `runCommand` (currently only logged) — deferred to a follow-up PR.
For v6.0.9 the `github-pr` ref is sufficient for the spec's readback
rule: a Phase 6 resume can verify the PR is still open before
deciding whether to retry.

**Files changed.** `src/cli/pr.ts` (270 insertions / 22 deletions),
`src/cli/index.ts` (+12 lines for engine knob plumbing),
`src/cli/help-text.ts` (+8 lines for the per-verb Options block +
breadcrumb), `tests/cli/pr-engine-smoke.test.ts` (new, 306 lines),
`docs/v6/wrapping-pipeline-phases.md` (status header + table row +
deviation note), `docs/v6/migration-guide.md` ("what works today" list
adds `pr`), `docs/specs/v6-run-state-engine.md` (reconciliation block
appended). Total: ~600 lines added, ~25 lines removed.

**Status after v6.0.9.** Nine of 10 phases wrapped. Remaining:
`implement` (v6.0.7) and `migrate` (v6.0.8) — both side-effecting,
both wrapped concurrently with this PR by parallel agents.
- **Bundled UI polish skills** — ships `/ui`, `/simplify-ui`, `/ui-ux-pro-max`,
  `/make-interfaces-feel-better` so consumers get them via `npm install` instead
  of needing user-level skill installs. `/ui` runs the chained pass (audit →
  simplify → align → polish); the other three are individual lenses. Auto-
  discovered via the existing `skills/` directory in the package `files`
  allowlist. Pairs with the design context loader
  (`src/core/ui/design-context-loader.ts`) — both gate on the same
  `hasFrontendFiles()` predicate so they only fire when frontend files change.

## v6.0.7 — wrap `implement` through `runPhaseWithLifecycle` (2026-05-07)

**Wraps the ninth pipeline phase.** Mechanical wrap following the v6.0.6
helper recipe. Engine-off path is byte-for-byte unchanged (advisory print
pointing at the Claude Code `claude-autopilot` skill); engine-on path
creates a run dir + emits run.start / phase.start / phase.success /
run.complete events. Concurrent dispatch — landed alongside v6.0.8
(`migrate`) and v6.0.9 (`pr`).

- New `src/cli/implement.ts` — `RunPhase<ImplementInput, ImplementOutput>`
  with `idempotent: true, hasSideEffects: false`. **Documented deviation
  from spec table:** the spec at line 159 of
  `docs/specs/v6-run-state-engine.md` lists `implement` with
  `idempotent: partial, hasSideEffects: yes, externalRefs: git-remote-push`.
  That declaration assumes the verb itself writes commits and pushes them
  to a remote. The v6.0.7 CLI verb does **not** write code, run tests,
  commit, or push to a remote — all of that lives in the Claude Code
  `claude-autopilot` skill (and its delegates: `subagent-driven-development`,
  `commit-push-pr`, `using-git-worktrees`). The CLI verb is the engine-wrap
  shell — its only side effect is writing the local
  `.guardrail-cache/implement/<ts>-implement.md` log stub. If a future PR
  inlines the implement loop into the CLI verb, the declarations flip to
  match the spec table and a `ctx.emitExternalRef({ kind: 'git-remote-push',
  id: '<commit-sha>' })` call lands after each push.
- CLI dispatcher in `src/cli/index.ts` — wires `--engine` / `--no-engine` /
  `--context` / `--plan` / `--output` / `--config` through the helper
  alongside `process.env.CLAUDE_AUTOPILOT_ENGINE`. Mirrors the validate /
  review / plan dispatcher shape.
- Help text in `src/cli/help-text.ts` — adds `implement` to the Pipeline
  group + per-verb Options block. Bumps `GLOBAL_FLAGS_BLOCK` to cite
  v6.0.7 alongside v6.0.1 → v6.0.5.
- New smoke test `tests/cli/implement-engine-smoke.test.ts` (6 cases) —
  asserts state.json + events.ndjson lifecycle, idempotent /
  hasSideEffects flags, env / CLI precedence, log file location.
- Test count: 1408 → 1414 (+6). `npm test` clean. `npx tsc --noEmit`
  clean except pre-existing fixture errors.

## v6.0.8 — wrap `migrate` through `runPhaseWithLifecycle` (2026-05-06)

**First side-effecting phase under the engine.** v6.0.1 → v6.0.6 wrapped
eight read-only / advisory verbs (`scan`, `costs`, `fix`, `brainstorm`,
`spec`, `plan`, `review`, `validate`). v6.0.8 wraps `migrate` — the
first verb that mutates external state (database schema). Builds on the
`runPhaseWithLifecycle` helper landed in v6.0.6 plus
`ctx.emitExternalRef()` from inside the phase body for the
`migration-version` ledger. No helper-shape changes needed.

**Phase declarations** match the spec table at line 162 of
`docs/specs/v6-run-state-engine.md`:

```
idempotent:     false   — dispatcher output varies by ledger state
                          (N applied on attempt 1, 0 on attempt 2 even
                          though both are operationally safe)
hasSideEffects: true    — applies migrations, writes audit log,
                          regenerates types, refreshes schema cache
externalRefs:   migration-version, scoped `<env>:<name>` per applied
                migration. Phase 6's resume gate will read these back
                against the live `migration_state` to decide
                skip-already-applied vs retry vs needs-human.
```

**Why `idempotent: false` even though the underlying Delegance migrate
skill is ledger-guarded against double-apply:** at the *engine
semantics* layer, `idempotent: true` means "re-running the phase against
the same input produces equivalent output." A dispatch invocation that
previously applied N migrations on attempt 1 and applies 0 on attempt 2
(everything already in the ledger) DOES produce different output
(different `appliedMigrations` list, different `status`). The spec's
`idempotent: false` is correct.

**Engine-off path is byte-for-byte identical to v6.0.7.** Same dispatch
shape (`src/core/migrate/dispatcher.ts` unchanged), same render lines,
same `--json` payload callback. CI / scripts that don't pass `--engine`
are unaffected.

| File | Role |
|---|---|
| `src/cli/migrate.ts` (new) | Engine-wrap shell calling `runMigrate(opts) → { exitCode, result }`. Defines `MigrateInput` / `MigrateOutput` (JSON-serializable), `RunPhase<MigrateInput, MigrateOutput>` with `name: 'migrate'`, `idempotent: false`, `hasSideEffects: true`. Phase body invokes the dispatcher and emits one `migration-version` externalRef per applied migration via `ctx.emitExternalRef({ kind: 'migration-version', id: '<env>:<name>' })`. Test seam: `__testDispatch` injects a fake dispatcher so smoke tests can exercise the engine-wrap path without spawning a child process or hitting a real database |
| `src/cli/index.ts` | dispatcher case for `migrate` routes through `runMigrate` instead of inlining `runMigrateDispatch`; threads `cliEngine` + `envEngine`. Engine-off byte-for-byte unchanged — same `--json` payload callback, same render |
| `src/cli/help-text.ts` | per-verb Options block for `migrate` documents `--engine` / `--no-engine` + `--config`; GLOBAL_FLAGS_BLOCK breadcrumb cites v6.0.8 |
| `tests/cli/migrate-engine-smoke.test.ts` (new) | 6 cases: engine off (default — no run dir), engine on (lifecycle events, state.json shape, idempotent: false + hasSideEffects: true declaration), externalRef emission per applied migration scoped by env, skipped status (zero externalRefs), dispatcher error → exit 1 + engine still records phase.success (domain failure ≠ engine failure), CLI `--no-engine` beats env on |
| `docs/v6/wrapping-pipeline-phases.md` | phase-status table flips `migrate` to "WRAPPED in v6.0.8"; status line at top moves to "NINE phases wrapped"; new deviation note documents the ledger-vs-engine-semantics rationale |
| `docs/v6/migration-guide.md` | "What works today" updated — three knobs now honored by `scan`, `costs`, `fix`, `brainstorm`, `spec`, `plan`, `review`, `validate`, `migrate` |
| `docs/specs/v6-run-state-engine.md` | new "What was actually built (v6.0.8)" reconciliation block |

**Test delta:** 1408 → 1414 (+6). Typecheck clean. All 1408 existing
tests pass unchanged — the engine-off path for `migrate` is byte-for-
byte identical to v6.0.7 (same dispatch shape, same render).

**Concurrency note.** v6.0.7 (`implement`) and v6.0.9 (`pr`) are in
flight on parallel worktrees, both targeting shared docs (CHANGELOG,
recipe table, migration-guide) and `src/cli/{index,help-text}.ts`. The
rebase contract: on push rejection, fetch + rebase + resolve conflicts
keeping all wraps' contributions, re-test, push with `--force-with-lease`.

**Not done in v6.0.8 — explicit non-goals:**
- Wrapping `implement` and `pr`. Continues across v6.0.7 / v6.0.9
  using the same helper plus `ctx.emitExternalRef()` for
  `git-remote-push` (implement) and `github-pr` (pr).
- Wiring Phase 6's `migration_state` read-back. The engine PERSISTS
  `migration-version` externalRefs in v6.0.8; consulting them on
  resume ships in Phase 6+. Until then, retries on side-effecting
  phases require `--force-replay`.
- Multi-phase pipeline orchestrator (autopilot's full
  `brainstorm → spec → plan → ... → migrate → ...` flow under one runId).
- Flipping the v6.0 built-in default to ON. v6.1 territory.

## v6.0.6 — `runPhaseWithLifecycle` helper (2026-05-06)

**Tech-debt refactor, no behavior change.** v6.0.1 → v6.0.5 wrapped eight
CLI verbs (`scan`, `costs`, `fix`, `brainstorm`, `spec`, `plan`, `review`,
`validate`) by hand-rolling the same ~100-line lifecycle pattern in each
file: `createRun → optional run.warning → runPhase → run.complete →
state.json refresh → best-effort lock release in finally`. Bugbot caught
the duplication on PR #97 (LOW severity, deferred) with the explicit
note: "extracting from 5 of 10 examples risks getting the abstraction
wrong; from 10 of 10 the pattern is fully evidenced." At 8 of 10, the
pattern is sufficiently evidenced that the remaining three side-effecting
phases (`implement`, `migrate`, `pr`) can use the same helper plus
`ctx.emitExternalRef()` from inside their phase body — no helper-shape
changes needed.

**The helper.** New `src/core/run-state/run-phase-with-lifecycle.ts` sits
on top of the existing `runPhase()` API (which is unchanged). Callers
continue to define their own `RunPhase<I, O>` with per-phase
`idempotent` / `hasSideEffects` / `run`, and pass it in alongside the
input, the loaded config, the engine knobs, and an `runEngineOff`
escape-hatch callback. The helper:

- Resolves engine on/off via the canonical CLI > env > config > default
  precedence
- On engine-off: invokes `runEngineOff()` and returns its result with
  `runId/runDir: null`
- On engine-on: creates a run dir, optionally emits `run.warning` for
  invalid env, runs the phase, emits `run.complete` (success or failed),
  refreshes `state.json` from replayed events, releases the lock in
  `finally` (idempotent), and returns `{ output, runId, runDir }`
- On phase failure: emits `run.complete` with `status: 'failed'`, prints
  the legacy `[<phase>] engine: phase failed — <msg>` banner to stderr
  byte-for-byte, releases the lock, and re-throws

**Migrated phases.** All eight wrapped verbs reduced. Each `runX(opts)`
function shrinks: keep the per-phase `RunPhase<I, O>` definition + the
engine-off path body; delete the lifecycle boilerplate; call
`runPhaseWithLifecycle` once. Total reduction across `src/cli/`:

- `scan.ts` 498 → 429 lines (-69)
- `costs.ts` 297 → 231 lines (-66)
- `fix.ts` 473 → 415 lines (-58)
- `brainstorm.ts` 251 → 189 lines (-62)
- `spec.ts` 216 → 159 lines (-57)
- `plan.ts` 269 → 199 lines (-70)
- `review.ts` 256 → 189 lines (-67)
- `validate.ts` 262 → 196 lines (-66)
- **Total: 2522 → 2007 lines (~515 lines saved)**

**Engine-off path is byte-for-byte unchanged.** All eight existing
`tests/cli/<verb>-engine-smoke.test.ts` smokes pass without modification
(44 cases). The helper supplies an `runEngineOff` callback so the legacy
code path stays intact even when the phase body's call shape would
otherwise pin it.

### Test count

After v6.0.5 baseline: 1396 → 1408 (+12). +12 cases for the new
`tests/run-state/run-phase-with-lifecycle.test.ts` covering: engine-off
(default + CLI > env > config precedence); engine-on success (lifecycle
events, state.json shape, env / config resolution, costUSD pass-through,
costUSD-absent fallback to 0); engine-on failure (run.complete failed,
state.json refresh, error re-thrown with original message preserved,
lock released through finally); invalid env value falling through to
config-resolved engine-on with `run.warning`. Existing 44 phase smokes
unchanged. Typecheck clean. Bugbot LOW from PR #97 addressed.

### Deliberately deferred

- Wrapping the remaining pipeline phases (`implement`, `migrate`, `pr`).
  Side-effecting phases need careful externalRef plumbing — they will
  build against `runPhaseWithLifecycle` plus `ctx.emitExternalRef()`
  from inside their phase body. Helper signature does not need to grow
  for them; documented in the helper's header comment.
- Multi-phase pipeline orchestrator (autopilot's full
  `brainstorm → spec → plan → ...` flow under one runId). The single-
  phase shape stays — multi-phase wrapping is a separate v6.x lift.
- Flipping the v6.0 built-in default to ON. v6.1 territory.

## v6.0.5 — Engine wire-up Part E (2026-05-06)

**The headline.** v6.0.4 wrapped `plan` and `review`. v6.0.5 continues the
mechanical wrap pattern from the recipe at
[`docs/v6/wrapping-pipeline-phases.md`](docs/v6/wrapping-pipeline-phases.md)
with one more single-shot, read-only verb:

- **`validate`** — new CLI verb. Engine-wrap shell for the validate
  pipeline phase. Writes a validate log stub under
  `.guardrail-cache/validate/`; the actual validation work (static
  checks, auto-fix, tests, Codex review with auto-fix, bugbot triage) is
  owned by the Claude Code `/validate` skill. Declared `idempotent: true,
  hasSideEffects: false` (local file write only; no provider calls, no
  git push, no PR comment, no SARIF upload).

**Documented deviation from the spec table.** The v6 spec
([docs/specs/v6-run-state-engine.md](docs/specs/v6-run-state-engine.md),
line 161) lists `validate` with externalRefs `sarif-artifact`. The
v6.0.5 wrap matches the `idempotent: true, hasSideEffects: false`
declaration but does **not** plumb a `sarif-artifact` externalRef — the
v6.0.5 `validate` CLI verb does not emit a SARIF artifact. SARIF
emission lives in `claude-autopilot run --format sarif --output <path>`
(a separate verb). The SARIF reference is local-only file output (no
remote upload), so the engine doesn't need a readback rule for it on
resume — `idempotent: true` covers replay safety. If a future PR adds
SARIF emission directly to this verb, the wrap can add a
`ctx.emitExternalRef({ kind: 'sarif-artifact', ... })` call after the
file write lands. Documented inline in `src/cli/validate.ts` and in the
wrapping recipe's deviation note.

The engine-off code path is byte-for-byte unchanged; the `validate`
verb is brand new in v6.0.5 (validation previously lived only as a
Claude Code skill).

### Test count

After v6.0.4 baseline: 1390 → 1396 (+6). +6 cases for
`validate-engine-smoke.test.ts`, mirroring the
`review-engine-smoke.test.ts` shape: engine off → no run dir + log
written; engine off (cliEngine: false); engine on → state.json +
events.ndjson with the right lifecycle (`run.start` →
`phase.start` → `phase.success` → `run.complete`); engine on with
explicit `--context`; env-resolved; CLI override beats env. Typecheck
clean.

### Deliberately deferred

- Wrapping the remaining pipeline phases (`implement`, `migrate`,
  `pr`). Side-effecting phases need careful externalRef plumbing per
  the recipe's "side effects" gate; wrap them last.
- Adding SARIF emission directly to the `validate` verb. Lives in
  `claude-autopilot run --format sarif` (separate verb).
- Extracting a shared `runPhaseWithLifecycle` helper across the eight
  wrapped verbs. Separate refactor PR — out of scope for v6.0.5.
- Flipping the v6.0 built-in default to ON. v6.1 territory.

## v6.0.4 — Engine wire-up Part D (2026-05-06)

**The headline.** v6.0.3 wrapped `brainstorm` and `spec`. v6.0.4 continues
the mechanical wrap pattern from the recipe at
[`docs/v6/wrapping-pipeline-phases.md`](docs/v6/wrapping-pipeline-phases.md)
with two more single-shot verbs:

- **`plan`** ([#98](https://github.com/axledbetter/claude-autopilot/pull/98)) —
  new CLI verb. Engine-wrap shell for the plan pipeline phase. Writes a
  plan markdown stub under `.guardrail-cache/plans/`; the actual
  LLM-driven planning content is owned by the Claude Code
  superpowers:writing-plans skill. Declared `idempotent: true,
  hasSideEffects: false` (local file write only; no provider calls, no
  git push, no PR comment).
- **`review`** ([#98](https://github.com/axledbetter/claude-autopilot/pull/98)) —
  new CLI verb. Engine-wrap shell for the review pipeline phase. Writes
  a review log stub under `.guardrail-cache/reviews/`; the actual
  LLM-driven review content is owned by the Claude Code review skills
  (`/review`, `/review-2pass`, `pr-review-toolkit:review-pr`). Declared
  `idempotent: true, hasSideEffects: false`.

**Documented deviation from the spec table.** The v6 spec
([docs/specs/v6-run-state-engine.md](docs/specs/v6-run-state-engine.md))
lists `review` with externalRefs `review-comments`, implying PR-side
comment posting (which would force `hasSideEffects: true`). The v6.0.4
`review` verb does **not** post anywhere — PR-side comment posting
lives in `claude-autopilot pr --inline-comments` /
`--post-comments` (a separate verb). If a future PR adds platform-side
comment posting to this verb, both declarations will need to flip and
the readback rules will need to plumb a `review-comments` externalRef.
Documented inline in `src/cli/review.ts`.

**Backward-compat — `review` grouping prefix preserved.**
`claude-autopilot review` (no args) still prints the alpha.2 prefix
help banner per the V16 v4-compat test. Flat-verb invocation requires
at least one flag, e.g. `claude-autopilot review --engine`.
`claude-autopilot help review` continues to surface the flat-verb
Options block via `buildCommandHelpText`.

Engine-off code paths are unchanged for both verbs.

### Test count

After v6.0.3 baseline: 1378 → 1390 (+12). +6 cases for
`plan-engine-smoke.test.ts`, +6 cases for `review-engine-smoke.test.ts`.
Both mirror `costs-engine-smoke.test.ts`: engine off → no run dir;
engine on → state.json + events.ndjson with the right lifecycle
(`run.start` → `phase.start` → `phase.success` → `run.complete`);
env-resolved; CLI override beats env. Typecheck clean.

### Deliberately deferred

- Wrapping the remaining pipeline phases (`implement`, `migrate`,
  `validate`, `pr`). Side-effecting phases (`implement`, `migrate`,
  `pr`) need careful externalRef plumbing per the recipe's "side
  effects" gate; wrap them last.
- Flipping the v6.0 built-in default to ON. v6.1 territory.

## v6.0.3 — Wrap brainstorm + spec through runPhase (2026-05-05)

**The headline.** v6.0.3 continues the mechanical phase-wrap pattern from
the recipe at
[`docs/v6/wrapping-pipeline-phases.md`](docs/v6/wrapping-pipeline-phases.md)
with two more pipeline verbs:

- **`brainstorm`** — the pipeline entry point. Implemented primarily as
  a Claude Code skill (`/brainstorm` → `superpowers:brainstorming`); the
  CLI verb is an advisory shim pointing the user there. The wrap declares
  `idempotent: true, hasSideEffects: false`. Engine-off path is
  byte-for-byte identical to v6.0.2 (the same advisory banner). Engine-on
  path creates a run dir + emits `run.start` / `phase.start` /
  `phase.success` / `run.complete`. `--json` envelope shape is preserved
  for back-compat with the WS7 welcome regression guard and
  `json-channel-discipline.test.ts`.
- **`spec`** — same shape as brainstorm. New top-level subcommand (it
  was previously absent from `SUBCOMMANDS`); the CLI verb is an advisory
  shim pointing at the autopilot/brainstorm Claude Code flow. Same wrap
  flags + same engine lifecycle.

**Documented deviation from the spec table.** The
[v6 spec table](docs/specs/v6-run-state-engine.md) declares both
`brainstorm` and `spec` `idempotent: no` because the LLM dialogue
produces new content each invocation. v6.0.3 declares `idempotent: true`
because the CLI verbs themselves are static advisory prints with no LLM
call and no externalRefs to reconcile — the engine's idempotency check
is "safe to retry without reconciliation," not "produces byte-identical
output." Justified inline at the top of `src/cli/brainstorm.ts` and
`src/cli/spec.ts` plus a deviation block in the recipe. Once the CLI
verbs grow real LLM bodies (a future v6.x lift), the declaration may
flip and a `spec-file` externalRef will land on every successful run.

Engine-off code paths are unchanged for both verbs; existing tests pass
without modification.

### Test count

1367 → 1378 (+11). +5 cases for `brainstorm-engine-smoke.test.ts`, +5
cases for `spec-engine-smoke.test.ts`, +1 case for `spec` joining
`MIGRATED_VERBS` in `json-channel-discipline.test.ts`. Both new smoke
files mirror `costs-engine-smoke.test.ts`: engine off → no run dir;
engine on → state.json + events.ndjson with the right lifecycle
(`run.start` → `phase.start` → `phase.success` → `run.complete`);
env-resolved; CLI override beats env. Typecheck clean.

### Deliberately deferred

- Wrapping the six remaining pipeline phases (`plan`, `implement`,
  `migrate`, `validate`, `pr`, `review`). One or two per release across
  v6.0.4+. A parallel agent works `plan` + `review` for v6.0.4.
- Promoting `brainstorm`/`spec` from advisory shims to full LLM-bearing
  CLI verbs. The Claude Code skill remains the user-facing entry point;
  the CLI wraps exist so the engine has a place to record run-state for
  future multi-phase orchestration.

## v6.0.2 — Engine wire-up Part B (2026-05-06)

**The headline.** v6.0.1 wrapped the first pipeline phase (`scan`) through
`runPhase`. v6.0.2 continues the mechanical wrap pattern from the recipe at
[`docs/v6/wrapping-pipeline-phases.md`](docs/v6/wrapping-pipeline-phases.md)
with two more single-shot verbs:

- **`costs`** ([#96](https://github.com/axledbetter/claude-autopilot/pull/96)) —
  pure read-only summary of the local cost ledger. The cleanest possible
  wrap: `idempotent: true, hasSideEffects: false`, no provider, no LLM,
  no file writes. CLI dispatcher passes `cliEngine` + `envEngine` through;
  `--config` flag also wired since the engine resolver consults config.
- **`fix`** ([#96](https://github.com/axledbetter/claude-autopilot/pull/96)) —
  applies LLM-generated patches to local files. Declared
  `idempotent: true` (same finding + same file content → same patch) and
  `hasSideEffects: false` (no remote / git push / PR creation in the
  existing flow — purely local file edits, which the recipe defines as
  platform-side-effect-free). If/when fix grows a `--push` mode it will
  flip to `hasSideEffects: true` with a `git-remote-push` externalRef.

**Documented deviation from the recipe.** Both wraps follow the recipe
mechanically. `fix` adds one explicit deviation: its phase body emits
per-finding console output and reads a [y/n/q] confirmation via
`readline`. Pure side-effect-free phase bodies are the recipe default,
but interactive verbs are an explicit exception (same precedent as
`scan` keeping its LLM call inside `executeScanPhase`). The summary line
+ exit-code logic still lives in `renderFixOutput` so the engine path's
idempotency isn't coupled to the final stdout shape. See the new "Note
on interactive verbs" section at the bottom of the wrapping recipe.

Engine-off code paths are byte-for-byte unchanged for both verbs;
existing tests pass without modification.

### Test count

1356 → 1367 (+11). +6 cases for `costs-engine-smoke.test.ts`, +5 cases
for `fix-engine-smoke.test.ts`. Both mirror `scan-engine-smoke.test.ts`:
engine off → no run dir; engine on → state.json + events.ndjson with
the right lifecycle (`run.start` → `phase.start` → `phase.success` →
`run.complete`); env-resolved; CLI override beats env. Typecheck clean.

### Deliberately deferred

- Wrapping the seven remaining pipeline phases (`brainstorm`, `plan`,
  `implement`, `migrate`, `validate`, `pr`, `review`). One or two per
  release across v6.0.3+.
- Flipping the v6.0 built-in default to ON. v6.1 territory.

## v6.0.1 — Engine wire-up Part A (2026-05-05)

**The headline.** v6.0 shipped the engine modules but left the user-facing
knobs un-wired. This release lights up the three knobs (`--engine` /
`--no-engine` CLI flag, `CLAUDE_AUTOPILOT_ENGINE` env var,
`engine.enabled` config key) with explicit precedence (CLI > env > config
> built-in default) and wraps the **first** pipeline phase — `scan` —
through `runPhase`. Every other pipeline phase still bypasses the engine;
those land one or two per PR across subsequent v6.0.x releases following
the recipe at [`docs/v6/wrapping-pipeline-phases.md`](docs/v6/wrapping-pipeline-phases.md).

The engine still ships **OFF** by default in v6.0.x. The default flip to
**ON** lands in v6.1 per [`docs/specs/v6.1-default-flip.md`](docs/specs/v6.1-default-flip.md).

### What landed (PR #95)

- **`resolveEngineEnabled()` precedence resolver.** Pure / no-IO function
  in `src/core/run-state/resolve-engine.ts`. Inputs:
  `{cliEngine?, envValue?, configEnabled?, builtInDefault?}`. Outputs:
  `{enabled, source, reason, invalidEnvValue?}`. Accepts case-insensitive
  env values `on/off/true/false/1/0/yes/no` (plus whitespace tolerance);
  invalid values fall through to the next-lowest precedence layer and
  surface the raw string in `invalidEnvValue` so the caller can emit a
  `run.warning`. **+45 unit tests** covering every precedence layer, every
  accepted env form, the conflict rules, and the invalid-env fallthrough.
- **CLI flag parsing in `src/cli/index.ts`.** New `parseEngineCliFlag()`
  helper rejects the conflict case (both `--engine` AND `--no-engine`)
  with `invalid_config` exit 1. Wired into the `scan` case to pass
  `cliEngine` + `envEngine` (from `process.env.CLAUDE_AUTOPILOT_ENGINE`)
  through to `runScan`.
- **Config schema** (`src/core/config/types.ts` + `schema.ts`). New
  optional `engine.enabled: boolean` knob; schema rejects unknown
  sub-keys (`additionalProperties: false`).
- **Help text** (`src/cli/help-text.ts`). New `GLOBAL_FLAGS_BLOCK`
  documents `--json` / `--engine` / `--no-engine` + the precedence
  matrix + scope (scan only in v6.0.1; rest follows the recipe). Per-verb
  `scan` Options block adds the new flags so `claude-autopilot help scan`
  is self-contained.
- **`scan` pilot phase wrapping** (`src/cli/scan.ts`). Refactored the
  LLM-call-and-finding-processing portion into `executeScanPhase(input)`
  → `ScanOutput` (pure, no console output, no exit-code logic). Defined
  `RunPhase<ScanInput, ScanOutput>` with `name: 'scan'`,
  `idempotent: true`, `hasSideEffects: false`. Engine-on path:
  `createRun()` → `runPhase()` → `run.complete` event +
  `replayState`/`writeStateSnapshot` refresh + best-effort lock release
  in `finally`. Engine-off path: `executeScanPhase(input)` directly,
  byte-for-byte unchanged from v6.0. Rendering extracted into
  `renderScanOutput()` so the engine path's idempotency isn't coupled
  to console output. Test seam (`__testReviewEngine`) lets the smoke test
  inject a fake without an LLM key.
- **End-to-end smoke test** (`tests/cli/scan-engine-smoke.test.ts`).
  Drives `runScan` with the engine on against a tmp project; asserts
  `state.status === 'success'`, single `scan` phase with the right
  `idempotent` / `hasSideEffects` flags, monotonic seq numbers, and the
  full lifecycle (`run.start` → `phase.start` → `phase.success` →
  `run.complete`). Five cases including engine-off (no run dir),
  env-resolved, CLI override, and invalid-env-fallthrough warning.
- **Wrapping recipe doc** (`docs/v6/wrapping-pipeline-phases.md`).
  Six-step recipe + phase-status table + idempotency decision tree +
  worked example (scan) + a checklist subsequent v6.0.x PRs follow when
  wrapping the remaining ten pipeline phases (`brainstorm`, `plan`,
  `implement`, `migrate`, `validate`, `pr`, `review`, `fix`, `costs`).
- **Migration guide** (`docs/v6/migration-guide.md`). "What works today"
  list updated — three knobs move from "wiring pending" to "wired (limited
  to scan)". Other phases still tracked under "wiring pending."
- **Spec reconciliation** (`docs/specs/v6-run-state-engine.md`). New "What
  was actually built (v6.0.1 — Part A)" block.

### Test count

1306 → 1356 (+50). Typecheck clean. Existing 1306 tests continue to pass
unchanged — the engine-off code path for `scan` is byte-for-byte
identical to v6.0.

### Deliberately deferred

- Wrapping of any other pipeline phase. Lands one or two per PR across
  v6.0.2+ following the recipe.
- Flipping the v6.0 built-in default to ON. v6.1 territory.
- Removing `--no-engine`. v7 territory.

## v6.0 — Run State Engine (2026-05-05)

**The headline.** Autopilot moves from a stateless command-stream to a
checkpointed, resumable, budget-bounded, observable pipeline. Every run gets
a ULID and a per-project directory at `.guardrail-cache/runs/<ulid>/`.
Every state transition appends a typed event to `events.ndjson` and updates
`state.json` atomically. Two-layer budget enforcement (advisory `estimateCost`
preflight + mandatory runtime guard) hard-stops runaway spend before it
happens. Every CLI verb grows a `--json` flag with strict stdout/stderr
channel discipline so CI consumers can drive the pipeline programmatically.
Side-effect phase replay decisions consult persisted `externalRefs` plus a
live provider read-back so resume is safe by construction. **v6.0 ships
with the engine OFF by default — opt-in via `engine.enabled: true` (config
wiring across 6.0.x point releases). Default flips to ON in v6.1.** See
[`docs/v6/migration-guide.md`](docs/v6/migration-guide.md) for the v5.x → v6
walkthrough and [`docs/v6/quickstart.md`](docs/v6/quickstart.md) for the
five-minute version.

### Per-phase landings

- **Phase 1 — Run State Engine persistence layer ([#86](https://github.com/axledbetter/claude-autopilot/pull/86)).** `RunState` / `RunEvent` / `PhaseSnapshot` / `ExternalRef` / `WriterId` types in `src/core/run-state/types.ts`. Pure-TS 26-char Crockford Base32 ULID generator (`ulid.ts`). Per-run advisory lock via `proper-lockfile` + `.lock-meta.json` sidecar with PID + SHA-256-hashed hostname; off-host writers default to alive (fail closed) so a network-mounted lock can't be stolen. Durable append protocol for `events.ndjson` (`open(O_APPEND)` → `write` → `fsync(fd)` → `close` per event) with monotonic `seq` via `.seq` sidecar. Truncated last-line detection emits `run.recovery(reason: 'recovered-from-partial-write')` and continues; mid-file corruption throws `partial_write` immediately. Atomic snapshot writer for `state.json` (`open(.tmp)` → `fsync(fd)` → `rename` → `fsync(dirfd)`; tmpfs/SMB compatibility via swallowed EISDIR/EPERM/ENOTSUP on the dir-fsync). `recoverState` falls back to events replay when `state.json` is missing/corrupt. `createRun` / `listRuns` / `gcRuns` lifecycle helpers; symlink-safe GC. New `ErrorCode` variants: `lock_held`, `corrupted_state`, `partial_write`. **+56 tests.**
- **Phase 2 — Phase wrapper + lifecycle ([#87](https://github.com/axledbetter/claude-autopilot/pull/87)).** `RunPhase<I, O>` interface (`idempotent` / `hasSideEffects` / `estimateCost?` / `run` / `onResume?`). `runPhase` orchestrator emits `phase.start` → `phase.success`/`failed` and gates idempotent short-circuit + side-effecting replay. Atomic per-phase snapshot writer (`writePhaseSnapshot` with path-traversal rejection on phase names). Hidden CLI verb `claude-autopilot internal log-phase-event` exposed via `cli-internal.ts` so markdown-driven skills can append events without importing the engine. Sub-phase nesting via synthetic `phaseIdx` encoding (`parentIdx * 1000 + childOrdinal`). **+27 tests.** Spec deviation: idempotent-replay short-circuit emits `run.warning(details.reason: 'idempotent-replay')` instead of a new `phase.skipped` event variant — durable log doesn't need a new shape since the snapshot is identical.
- **Phase 3 — `runs` / `run resume` CLI ([#88](https://github.com/axledbetter/claude-autopilot/pull/88)).** Six verbs: `runs list` (newest-first, `--status` filter), `runs show <id>` (state + optional events tail), `runs gc` (default 30-day cutoff, confirmation gate), `runs delete <id>` (terminal-status guard + lock acquisition), `runs doctor` (replay vs snapshot drift; `--fix` rewrites), `run resume <id>` (**lookup-only** in v6.0 — identifies next phase + decision rationale; live execution wires in 6.1+). Every verb supports `--json` envelope output (v1 schema). New `Engine` group in `HELP_GROUPS`. Decision vocabulary (`retry` / `skip-idempotent` / `needs-human` / `already-complete`) preserved as a thin wrapper around the canonical `decideReplay` matrix introduced in Phase 6. **No changes to existing CLI verbs.**
- **Phase 4 — Budget enforcement ([#89](https://github.com/axledbetter/claude-autopilot/pull/89)).** `BudgetConfig` (`perRunUSD`, `perPhaseUSD?`, `councilMaxRecursionDepth?`, `bgAutopilotMaxRoundsPerSelfEat?`, `conservativePhaseReserveUSD?`). `checkPhaseBudget` pure decision function with two-layer policy: (1) advisory — uses `estimateCost.high` if the phase declares one; (2) mandatory — runs regardless, enforces `actualSoFar + conservativePhaseReserveUSD <= perRunUSD` so phases without `estimateCost` still trigger budget gates. `runPhase` emits a `budget.check` event with full decision rationale (`{phase, phaseIdx, estimatedHigh, actualSoFar, reserveApplied, capRemaining, decision, reason}`) before every spawn; throws `GuardrailError(budget_exceeded)` on hard-fail. Council synthesizer recursion bounded via `councilMaxRecursionDepth` — exceeded calls return `status: 'partial'` rather than continuing. **+25-30 tests.**
- **Phase 5 — Typed JSON events + strict `--json` channel discipline ([#90](https://github.com/axledbetter/claude-autopilot/pull/90)).** `--json` flag now lives on every Review / Pipeline / Deploy / Migrate / Diagnostics verb. Strict channel contract enforced by a dispatcher-level wrapper (`runUnderJsonMode` in `src/cli/json-envelope.ts`): exactly **one** JSON envelope on stdout per invocation; **only** NDJSON event lines on stderr (synthetic `run.warning` for legacy text via `installJsonModeChannelDiscipline` console-wrap); ANSI color codes stripped; interactive prompts hard-fail with `EXIT_NEEDS_HUMAN = 78` and the envelope's `nextActions` field carries the resume hint. Text-mode behavior unchanged. **`tests/cli/json-channel-discipline.test.ts` asserts the invariants per migrated verb.**
- **Phase 6 — Idempotency contracts + provider read-back ([#91](https://github.com/axledbetter/claude-autopilot/pull/91)).** `decideReplay` pure decision matrix in `replay-decision.ts` maps `(priorSuccess, idempotent, hasSideEffects, refs, readbacks, forceReplay)` → `'retry' | 'skip-already-applied' | 'needs-human' | 'abort'`. Pluggable `ProviderReadback` registry in `provider-readback.ts` with built-in read-backs for `github` (via `gh` CLI), `vercel` / `fly` / `render` (via the deploy adapters), `supabase` (via `migration_state`). All read-backs **fail closed** — any throw, parse failure, or unrecognized state collapses to `existsOnPlatform=false, currentState='unknown'` so the matrix routes to `needs-human` instead of a silent skip. `runPhase` wires `decideReplay` (replaces Phase 2's hard-coded throw). New `replay.override` event variant emitted when `--force-replay` flips a refusal into a retry; `foldEvents` records overrides on `phase.meta.replayOverrides`. `PhaseSnapshot.result` field added so `skip-already-applied` returns the prior output without re-execution. CLI lookup (`runRunResume`) delegates to the same `decideReplay` so prediction matches live execution. **+55 tests.**
- **Phase 7 — Live adapter certification suite ([#92](https://github.com/axledbetter/claude-autopilot/pull/92)).** Five live assertions × three providers (Vercel + Fly + Render): deploy success, auth failure, 404, rollback, log streaming with redaction-on-planted-secret. Env-gated via `resolveProviderEnv()` — runs report `skipped` until the operator adds the seven `*_TEST` GitHub Secrets per `docs/adapters/cert-suite.md`. Flake-control harness (`tests/adapters/live/_harness.ts`) implements per-provider 3-attempt retry budget with exp backoff (1s / 4s / 16s) on transient categories, hard-fail (no retry) on auth/404/schema-mismatch, soft-fail with 3-strike escalation on rollout/log-streaming flakes; **+42 unit tests** for the harness alone (run under regular `npm test`, no live creds required). Nightly CI workflow at `.github/workflows/adapter-cert.yml` (09:00 UTC + manual `workflow_dispatch`); uploads `events.ndjson` + `log-tail.txt` artifacts on every run. **Spec deviation:** Fly cert needs a third env var (`FLY_IMAGE_TEST`) since the Fly adapter doesn't build images per the v5.6 design.
- **Phase 8 — Docs + migration guide ([#94](https://github.com/axledbetter/claude-autopilot/pull/94), this PR).** `docs/v6/migration-guide.md` walks v5.x users through the opt-in flow with a precedence matrix, troubleshooting recipes, the per-phase idempotency table, and the v6.0 → v6.1 default-flip plan. `docs/v6/quickstart.md` is the five-minute version. README gains a "Run State Engine (v6)" section. CHANGELOG (this entry) bundles every phase. Spec gets a Phase 8 reconciliation block + a Status column on the implementation phases table. New `docs/specs/v6.1-default-flip.md` outlines the stabilization criteria for flipping `engine.enabled` to `true` by default and removing `--no-engine`.
- **Spec — Codex-reviewed twice ([#85](https://github.com/axledbetter/claude-autopilot/pull/85)).** Two passes through Codex 5.3 hardened the persistence protocol (durable append + atomic snapshot ordering), promoted `events.ndjson` to source-of-truth with `state.json` as a derived cache, mandated copy-not-symlink for artifacts, added the two-layer budget policy with a mandatory runtime guard, formalized the strict `--json` channel discipline, defined the external-operation ledger for replay safety (`ExternalRef` + provider read-back), pinned the precedence matrix, and added flake-control parameters for the live adapter cert suite.

### Codex / council pricing — from the GPT-5.5 swap ([#93](https://github.com/axledbetter/claude-autopilot/pull/93))

- **Default codex/council model bumped `gpt-5.3-codex` → `gpt-5.5`.** OpenAI
  released GPT-5.5 (codename Spud) on 2026-04-23 — better at coding than 5.4
  with fewer tokens, available via standard Responses/Chat Completions API
  at `gpt-5.5` (no `-codex` suffix). Pricing **doubles** to $5/1M input +
  $30/1M output, so the per-adapter `COST_PER_M_INPUT/OUTPUT` defaults moved
  in lockstep — without this, every cost-ledger entry would silently halve.
  New canonical pricing table at `src/adapters/pricing.ts` keeps the legacy
  `gpt-5.3-codex` and `gpt-5.4` entries for back-compat with pinned
  `CODEX_MODEL`/`council.models[].model` configs. Override via env vars
  (`CODEX_MODEL`, `CODEX_COST_INPUT_PER_M`, `CODEX_COST_OUTPUT_PER_M`).

## v5.6.0 — Fly.io + Render deploy adapters (2026-05-04)

### Added

- **`@delegance/claude-autopilot deploy --adapter fly`** — first-class Fly.io adapter. Image-based releases via the Machines API (image must be pre-pushed via `fly deploy --build-only --push`), polling-based status, **WebSocket log streaming**, **native rollback** with simulated fallback when the API endpoint is unavailable. `FLY_API_TOKEN` env var; auth doctor warns when missing.
- **`@delegance/claude-autopilot deploy --adapter render`** — first-class Render adapter. REST API deploys (with optional `clearCache`), service-scoped status polling at `GET /v1/services/{serviceId}/deploys/{deployId}`, REST-polling log stream with `(timestamp, logId)` cursor dedup, **simulated rollback** by re-deploying the previous successful commit. `RENDER_API_KEY` env var; auth doctor warns when missing.
- **`DeployAdapterCapabilities` interface** — adapters declare `streamMode: 'websocket' | 'polling' | 'none'` and `nativeRollback: boolean`. CLI prints a one-line stderr notice for polling-mode adapters under `--watch` so users understand why log lines arrive in batches.
- **Bounded auto-rollback orchestration in `src/cli/deploy.ts`** — when health check fails after deploy and `rollbackOn: [healthCheckFailure]` is configured, the CLI fires exactly one rollback (no chains), with `runHealthCheck` capped at 5 attempts × 6s backoff (~30s window). New terminal `DeployResult.status` values: `fail_rolled_back` and `fail_rollback_failed`.
- **HTTP-status error taxonomy** — new `not_found` `ErrorCode` joins the union; per-adapter mapping: 401/403→`auth`, 404→`not_found`, 422/400→`invalid_config`, 5xx→`transient_network` (retryable). Provider request-id headers (`Fly-Request-Id`, `x-request-id`) captured into `error.details` for support tickets.
- **Mandatory log redaction across all adapters** — every log line surfaced into `DeployResult.output` or PR-comment bodies runs through `redactLogLines()` (defaults: `AKIA…`, `sk-…`, `eyJ…`, `ghp_`, `xoxb-`, plus user-configurable `config.persistence.redactionPatterns`). Closes a real existing security hazard in the v5.4 Vercel adapter that was emitting unredacted logs into PR comments.
- **Shared `src/adapters/deploy/_http.ts`** — extracted `fetchWithRetry` + `safeReadBody` helpers used by Vercel, Fly, and Render adapters; one canonical retry implementation to maintain.

### Fixed

- **Bugbot caught + autopilot fixed 4 real bugs across the v5.6 self-eat phases.** HIGH on Phase 2 (Render service-scoped URL — `pollUntilTerminal` and `status()` were using shorthand `/v1/deploys/{id}` which doesn't exist on Render's API). MEDIUM on Phase 3 (Render cursor dedup wasn't sorting same-ms entries by id, silently dropping out-of-order siblings). LOW on Phase 4 (`printAutoRollback` hardcoded "failed 3x" but the constant is now 5). LOW on Phase 5 (`getPreviousFileContent` was being called for `.sql` files where `previousContent` is ignored, wasting a `git show` spawn per migration).
- **Schema-alignment diff-aware Prisma parsing (PR #44, schema-alignment cleanup)** — `getPreviousFileContent` now defaults to a CI-aware base ref (`GITHUB_BASE_REF` → `origin/<base>`, then `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`, fallback `HEAD~1`) instead of always reading from `HEAD` (which gave empty diffs in CI). Dropped models now emit `drop_column` for every field of the removed model.
- **Tombstone CLI no longer crashes with a stack trace when presets are missing (PR #82)** — schema-validator was running file IO at module load time, so every `claude-autopilot --version` call eagerly read `presets/aliases.lock.json` + `presets/schemas/migrate.schema.json`; missing presets crashed the CLI before it could format an error. Now lazy-init via memoized `getValidator()`.

## v5.5.2 — Framework-agnostic /migrate (2026-04-30)

### Added

- **Working examples for Rails, Alembic, Django, golang-migrate, Prisma, Drizzle, dbmate, Flyway, supabase-cli, custom scripts** in `skills/migrate/SKILL.md`. The dispatcher was always framework-agnostic, but the prior doc text only described the Supabase path.
- **Detector `defaultCommand` fills** for `prisma-push`, `drizzle-push`, `golang-migrate`, `typeorm` so `claude-autopilot init` produces a working `stack.md` on first try for these toolchains.

### Fixed

- **`/migrate` skill description rewritten** as a generic dispatcher description with a "when to use migrate-supabase instead" callout. Anyone running `migrate@1` in a non-Supabase repo no longer sees Supabase-specific instructions.

## v5.5.1 — `openai` SDK now optional (2026-04-30)

### Changed

- **`openai` moved to `optionalDependencies`** alongside `@anthropic-ai/sdk`, `@google/generative-ai`, `@modelcontextprotocol/sdk`. All four LLM SDKs are now optional. `npm install --omit=optional` shed grows to **~26 MB** (was ~13 MB after v5.5.0). `scripts/autoregress.ts` migrated to `loadOpenAI()` — the last direct `import OpenAI` outside the adapter layer.

### Notes

- Council runner already handles missing-synth-SDK gracefully — returns `status: 'partial'` with the friendly install hint surfaced via the synthesis error field. Users with only `ANTHROPIC_API_KEY` get a partial result with model responses preserved.

## v5.5.0 — Lazy-load LLM SDKs + Vercel auth doctor (2026-04-30)

### Added

- **`src/adapters/sdk-loader.ts`** with `loadAnthropic` / `loadOpenAI` / `loadGoogleGenerativeAI` + `isSdkInstalled` helper. Friendly `GuardrailError` on `MODULE_NOT_FOUND` points at the exact `npm install` command.
- **Phase 6 of v5.4 spec — Vercel auth doctor.** `claude-autopilot doctor` detects `deploy.adapter: vercel` in `guardrail.config.yaml` and warns when `VERCEL_TOKEN` is missing.
- **LLM SDK install-state surface in doctor** — shows which optional LLM SDKs are actually installed.

### Changed

- **`@anthropic-ai/sdk`, `@google/generative-ai`, `@modelcontextprotocol/sdk` moved to `optionalDependencies`**. Six adapters converted from top-level import to dynamic load. Users with `--omit=optional` shed ~13 MB and only need the SDK matching their API key.

## v5.4.0 — Vercel first-class deploy adapter (2026-04-30)

### Added

- **`@delegance/claude-autopilot deploy --adapter vercel`** — first-class Vercel adapter via the v13 deployments API. Returns `dpl_xxx` IDs, polls status until terminal, populates `deployUrl` / `buildLogsUrl` / `output`. Auth via `VERCEL_TOKEN`.
- **`--watch` SSE+NDJSON log streaming** — subscribes to `/v2/deployments/<id>/events?builds=1`, prints to stderr in real time. Reconnects once with exp backoff on disconnect.
- **`claude-autopilot deploy rollback` + `deploy status`** — CLI subverbs over the adapter's `rollback()` / `status()` methods. `--to <id>` overrides "previous prod deploy" lookup.
- **Auto-rollback on health-check failure** — when `rollbackOn: [healthCheckFailure]` is set in config, the CLI promotes the previous prod deploy if the post-deploy health check fails. PR comment shows both URLs (new + rolled-back-to).
- **`<!-- claude-autopilot-deploy -->` upserting PR comment** — single comment is updated in place across deploy → log-stream → health-check → rollback, instead of spamming the PR with multiple comments.

### Fixed

- **Bugbot caught explicit `--config <missing>` was silently ignored on PR #63 (Phase 3)** — autopilot fixed it with a regression test in 4 minutes.
- **Phase 4 introduced a regression in Phase 2's `--watch` test surface; caught via `npm test` before PR opened**, autopilot adapted spec interpretation (made health-check opt-in instead of falling back to deployUrl) and documented the deviation.

### Notes

- This release was **shipped as four self-eat PRs** (#59, #61, #63, #64) where autopilot implemented its own next phase end-to-end. Cumulative cost ~\$17.50, wall clock ~82 min, 47 new tests. See [DEMO.md](DEMO.md) for the full proof set.
- v5.3 "deploy phase" was superseded by v5.4 — the adapter pattern subsumed the generic-command-only design from the in-flight v5.3 spec.

## v5.2.2 — Demo polish

### Fixed

- **Cost log skips zero-token entries.** Setup-flow scans, dry-runs, and no-findings paths were polluting the log with empty rows that drowned real review entries in `claude-autopilot costs` output.
- **`costs` shows scope.** Output now explicitly notes "per-project — scoped to `<cwd>/.guardrail-cache/costs.jsonl`" so users understand it's not a global aggregate.
- **`pr` no longer hard-fails on missing config.** First-run on a fresh repo now auto-detects + prints a remediation line pointing at `setup`.

### Added

- **DEMO.md committed at repo root.** Real end-to-end pipeline run on randai-johnson (multi-file Python integration, 12 min wall clock, $2.20 spend, 5 new tests, zero manual intervention). Linkable from external docs / pitch material.

## v5.2.1 — Stress-test polish

### Fixed

- **venv detection in tests phase.** `pytest -q` now resolves to `<project>/.venv/bin/pytest` (or `venv/`, `env/`) when present, so `claude-autopilot pr` no longer reports "tests failed" on Python repos with venv-installed pytest.
- **`autoregress` 100% broken on global install** — the bridge resolved `SCRIPT` to `dist/scripts/autoregress.ts` under the compiled layout, but `scripts/` ships at the package root. Every invocation threw `ERR_MODULE_NOT_FOUND`. Now uses `findPackageRoot` + existence check.
- **Council in python preset.** Python preset now ships a commented `council:` template (mirrors the generic preset). Out-of-the-box `init --preset python` no longer requires manual schema discovery.
- **Regression-lane fixture top-level await.** CI workflow's `npx tsx -e "..."` blocks wrapped in `async () => {...}` so esbuild's CJS output accepts them. Plus expected-ledger.json updated to match v5.2.0's new version format.

## v5.0.8 — Line extraction + fix gate

### Fixed

- **Parser extracts "line N" / "on line N" / "at line N" from prose** when not adjacent to a file ref. Previously findings shipped with file but no line, so `fix --dry-run` reported "no fixable findings" on a non-empty findings list.
- **`fix` distinguishes actionable (file present) from fixable (file + line).** Dry-run surfaces actionable findings even when line-less, with a clear message about why the LLM-fix loop can't act on them.

## v5.0.7 — File backfill + cost ledger consolidation

### Fixed

- **Single-file scan unconditionally backfills the file path.** The 5.0.6 fallback only triggered on `<unspecified>`, so prose-noise like `"n.r"` slipped through and broke `fix`.
- **`pr-desc` and `council` now persist to the cost ledger.** Previously only `scan` and `run` were tracked, so `claude-autopilot costs` showed misleadingly low totals after multi-call sessions.
- **Single-letter code extensions removed from bare-reference parser** (c/d/h/m/r/s) — they still match when backtick-wrapped, but bare matches like "n.r" no longer slip through.
- **`appendCostLog` swallows write errors centrally.** Cost log is observability, not a contract — a read-only FS or full disk no longer crashes commands that already succeeded.

## v5.0.6 — Setup YAML + branch fallback

### Fixed

- **`setup` no longer writes duplicate `testCommand` keys.** Several presets (go, python, python-fastapi, rails-postgres) ship with their own `testCommand:` line; `cli/setup.ts` was unconditionally appending another, producing invalid YAML that hard-failed every command after `setup` on those stacks.
- **Single-file scan backfills file path** (initial fix; superseded by v5.0.7's unconditional version).
- **Branch-derived PR titles default to `chore:` for unknown prefixes.** `autopilot-test/validate-weights` → `chore: validate weights` instead of `autopilot test validate weights` (which fails commitlint).

## v5.0.5 — Python detect + parser hardening

### Added

- **`presets/python/`** — general Python config (pytest, ruff, hardcoded-secrets, common protected paths). Detector now picks it for any `pyproject.toml` or `requirements.txt` without FastAPI signals (was falling through to the JS/Generic preset).

### Fixed

- **Parser rejects "e.g" / "i.e" / "etc" prose as file refs.** The prior regex `\.[a-z]{1,6}` accepted any 1-6 letter suffix, so prose like "(e.g. dict, list)" was matched. Bare references now require a known code-file extension.
- **`pr-desc` real titles.** Prompt now explicitly asks for a Title line; parser falls through to a branch-derived conventional-commit title (`fix/cost-tracker` → `fix: cost tracker`), then first summary bullet, then `chore: update` only as a last resort.
- **`runReviewOnTestFail` default flipped to `true`.** Failed/missing test commands no longer silently kill the LLM review phase. Strict gating still available via explicit `false`.

## v5.0.4 — Council Responses API

### Fixed

- **Council 404s on `gpt-5.3-codex` resolved.** Codex variants and o-series reasoning models are Responses-API-only — the council adapter only used `client.chat.completions`. Now branches by model name (`/codex|^o[1-9]|^gpt-5\.3-/`) to use `client.responses.create()` for those models. Fixes the multi-model differentiator for any user with only `OPENAI_API_KEY`.
- **Generic preset ships a working council template.**

## v5.0.3 — Cost tracker

### Fixed

- **Codex adapter computes `costUSD`** (was returning `usage` without a cost field, so every codex run logged $0).
- **`scan` now persists to cost log** (was only `run` writing entries).

## v5.0.2 — Post-install friction

### Fixed

- **preflight `tsx` false-positive eliminated.** Every fresh global install reported `✗ tsx available` blocker because the bundled tsx wasn't checked. Now uses `findPackageRoot(import.meta.url)`.
- **Top-level `unhandledRejection` + `uncaughtException` handlers** format `GuardrailError` as a single-line red message instead of a Node stack trace. `CLAUDE_AUTOPILOT_DEBUG=1` re-enables stack.
- **Tarball trimmed:** dropped `src/` + `*.map` from `files` array → 319 files / 182 kB packed (was 726 / 382 kB), -56% / -52%.
- **Stale strings:** `@alpha` install hint → `@latest`; `npx guardrail run` blocker text → `claude-autopilot run`; init deprecation banner removed (both verbs work).

## v5.0.1 — Types + tombstone

### Fixed

- **Ships `dist/src/index.d.ts`** for TypeScript consumers.
- **Tombstone `@delegance/guardrail` package** publishes a forwarder pointing at the renamed package; pre-rename versions deprecated with migration message.

## v5.2.0 — Migrate skill generalization

### Added

- **Generalized migrate phase** — `migrate@1` (thin orchestrator), `migrate.supabase@1` (rich Delegance runner, paths now parameterized via stack.md), `none@1` (no-op for `--skip-migrate`). Pipeline reads `.autopilot/stack.md` to dispatch the right skill.
- **Auto-detection at init** — `claude-autopilot init` walks the repo, sniffs for Prisma / Drizzle / Rails / Go-migrate / Flyway / dbmate / Alembic / Django / Ecto / TypeORM / Supabase signals, writes a stack.md non-interactively when there's a single high-confidence match. Prompts otherwise.
- **Stack.md schema validation** with security rules: shell metachars rejected in command args, env_file paths confined under project_root, dev_command-as-prod-command blocked.
- **Versioned alias map** (`presets/aliases.lock.json`) with stable IDs (`migrate@1`, `migrate.supabase@1`, `none@1`) so future renames don't break user configs.
- **Skill manifest version handshake** — every skill ships `skill.manifest.json` declaring `skill_runtime_api_version`, `min_runtime`, `max_runtime`. Dispatcher fails closed on incompatibility with explicit upgrade hints.
- **Hash-chained audit log** at `.autopilot/audit.log` (JSONL, monotonic seq + SHA-256 prev_hash chain) for every migrate dispatch. `claude-autopilot doctor` validates the chain.
- **Per-policy enforcement points** — `allow_prod_in_ci`, `require_clean_git`, `require_manual_approval`, `require_dry_run_first`. CI prod migrations require all 4 of: `--yes` flag, `AUTOPILOT_CI_POLICY=allow-prod`, `AUTOPILOT_TARGET_ENV=<env>`, stack.md `policy.allow_prod_in_ci: true`. Plus a recognized CI provider env (or `AUTOPILOT_CI_PROVIDER` override).
- **Structured argv execution** — commands stored as `{ exec, args[] }` and executed via `spawn(shell:false)`. No shell injection vector. Legacy string form deprecated, auto-migrated by `doctor --fix`.
- **`migrate doctor`** with read-only mode (default) and `--fix` mode for safe auto-corrections.
- **Monorepo support** — per-workspace `.autopilot/stack.md` plus root `.autopilot/manifest.yaml` for cross-workspace coordination.
- **Legacy migrate skill migrator** — automatically archives the existing `skills/migrate/` (legacy Delegance Supabase shape) to `skills/migrate.backup-<ISO>/` on `doctor --fix`, replaces with the thin shape.
- **Multi-CI provider detection** — GitHub Actions, GitLab CI, CircleCI, Buildkite, Jenkins recognized out of the box. `AUTOPILOT_CI_PROVIDER` override for self-hosted.
- **Delegance regression CI lane** — required GitHub Actions job that runs the full migrate-supabase flow against an anonymized fixture, asserting byte-for-byte ledger compatibility with pre-dispatcher behavior.

### Changed

- `skills/autopilot/SKILL.md` Step 4 (Migrate) rewritten to describe the envelope-based dispatcher contract instead of invoking `/migrate` directly.

### Backward-compat

- Delegance's existing `npx tsx scripts/supabase/migrate.ts` CLI invocation still works unchanged. The script now ALSO honors the autopilot dispatcher when invoked with `AUTOPILOT_ENVELOPE` + `AUTOPILOT_RESULT_PATH` env vars; falls back to legacy CLI parsing otherwise.
- The old `skills/migrate/` legacy SKILL.md is preserved (and will be auto-archived on first `doctor --fix` post-upgrade).

### Migration guide for existing users

```bash
# Upgrade
npm install -g @delegance/claude-autopilot@5.2.0

# Audit current state (read-only, exits non-zero if migration needed)
claude-autopilot doctor

# Apply auto-fixes (archives legacy /migrate skill, writes new stack.md)
claude-autopilot doctor --fix
```

Existing `npx tsx scripts/supabase/migrate.ts <file> --env dev` workflows are unaffected.

## [5.0.0] — 2026-04-27

First GA release after a five-alpha soak cycle. Promotes `5.0.0-alpha.5` to GA unchanged on the code side; the only diff is the version bump, README rebranding away from `@alpha` channel guidance, and a new "Reproducing the benchmark" section.

### Added
- **README hero benchmark.** Documented 13/13 on the seeded Next.js fixture with Claude Opus at $0.21 / 38s. Includes a "Reproducing the benchmark" section at the bottom with the full procedure, the categories measured, and explicit non-claims (e.g. doesn't measure false-positive rate on clean repos).
- README install instructions now use bare `npm install -g @delegance/claude-autopilot` (no `@alpha` pin) — assumes the `latest` dist-tag has advanced to 5.0.0.

### Changed
- Migration guide install snippets drop the `@alpha` pin and the alpha-cycle warning.
- Removed the alpha-era CLI note from the README ("Alpha.1 CLI note: subcommands are flat …" → just "CLI note").

### Manual GA steps (for the publisher)
After this lands and `v5.0.0` is tagged + auto-published:

1. `cd packages/guardrail-tombstone && npm publish` — publishes `@delegance/guardrail@5.0.0` thin wrapper.
2. `npm dist-tag add @delegance/claude-autopilot@5.0.0 latest` — moves `latest` from the legacy 2.5.0 to GA.
3. `npm deprecate @delegance/claude-autopilot@"<5.0.0" "Pre-rename — use 5.x"` — flags the orphaned 1.0.0-rc.1 / 2.x / 5.0.0-alpha.* releases.
4. `npm deprecate @delegance/guardrail@"<5.0.0" "Renamed — use @delegance/claude-autopilot"` — tells v4 users to migrate (the `5.0.0` tombstone forwards their existing CLI usage transparently).

## [5.0.0-alpha.5] — 2026-04-27

Second hotfix from the soak. Alpha.4 fixed `init`'s preset resolution but `scan` / `run` still crashed on compiled output with `Failed to import adapter from .../auto.ts` — the adapter loader and static-rule registry use dynamic-import string literals that tsc's `rewriteRelativeImportExtensions` doesn't touch.

### Fixed
- **`scan` / `run` adapter loading under compiled JS.** `src/adapters/loader.ts` BUILTIN_PATHS and `src/core/static-rules/registry.ts` import map both used hardcoded `.ts` extensions in dynamic-import string literals. TS's emit-time rewriter only handles static imports, so these strings stayed `.ts` post-compile and the runtime tried to load `dist/.../auto.ts` (which doesn't exist; the file is `auto.js`). New helper `resolveSiblingModule()` in `src/cli/_pkg-root.ts` swaps `.ts` → `.js` based on whether the caller is itself compiled.

### Added
- **Real-world soak benchmark result.** Against a 13-bug seeded Next.js fixture (SQL injection, hardcoded secret, missing auth, IDOR, CORS wildcard, SSRF, open redirect, TOCTOU, silent error swallow, off-by-one, missing rate limit, console.log, no input validation), `claude-autopilot scan --all` with the `claude` adapter caught **13 of 13** with concrete remediation. The cold-start eval reviewer's original run with Llama 3.3 70B caught 8/13 (and even that was blocked by the parser bug now fixed).
- 4 new tests in `tests/pkg-root.test.ts` covering `resolveSiblingModule` semantics across source/.js/.mjs callers, plus a regression test that compiles `dist/` and imports the registry to verify dynamic-import refs resolve.

## [5.0.0-alpha.4] — 2026-04-27

Hotfix discovered by post-publish soak. The previous alpha.3 published a compiled `dist/` bundle but the path-resolution sites that look up `presets/`, `package.json`, etc. assumed source-tree layout (`../..` from `src/cli/<file>.ts` = package root). Under the compiled layout (`dist/src/cli/<file>.js`), the same `../..` resolves to `dist/`, which doesn't contain `presets/` or `package.json`. Result: `npx @delegance/claude-autopilot@alpha init` crashed with "Preset config not found for: generic" — a release-blocker missed by every prior CI check.

### Fixed
- **`init` / `setup` no longer crash on compiled output.** All sites that previously did `path.resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')` now use `findPackageRoot()` from a new shared helper at `src/cli/_pkg-root.ts`. The helper walks up from `import.meta.url` looking for the `@delegance/claude-autopilot` `package.json`, so it lands on the same package root whether the caller is source or compiled.
- Affected sites: `src/cli/setup.ts`, `src/cli/init.ts`, `src/cli/run.ts` (`readToolVersion`), `src/cli/pr-comment.ts` (`readVersion`).

### Added
- `src/cli/_pkg-root.ts` — `findPackageRoot()` and `requirePackageRoot()`.
- `tests/pkg-root.test.ts` — unit test for the helper, plus a full integration smoke that builds `dist/`, invokes `node dist/src/cli/index.js init --preset generic` against a fresh temp project, and asserts `guardrail.config.yaml` is written. Catches future compiled-vs-source path drift.

### Notes for users on alpha.3
- If you ran `npx @delegance/claude-autopilot@alpha init` on alpha.3 and saw "Preset config not found", upgrade with `npm install -g @delegance/claude-autopilot@alpha` to pick up alpha.4. No config changes needed.

## [5.0.0-alpha.3] — 2026-04-24

Final alpha before v5.0.0 GA. Closes every remaining GA blocker from the alpha cycle.

### Added
- **Compiled JS entrypoint** — `npm run build` emits `dist/src/**/*.js` via `tsc -p tsconfig.build.json`. The launcher at `bin/_launcher.js` prefers the compiled output when present (global installs), falls back to `src/` + `tsx` for dev workflows. Drops `tsx` from the runtime hot path for published installs. Uses TypeScript 6's `rewriteRelativeImportExtensions: true` to rewrite `.ts` → `.js` specifiers at emit time; includes a defensive post-build rewriter script that no-ops when tsc already did the work.
- **`claude-autopilot migrate-v4` codemod** — `src/cli/migrate-v4.ts`. Scans a target repo for `@delegance/guardrail` and `guardrail <verb>` references, proposes replacements, applies with `--write` (creates `.v4-backup.<timestamp>` files and writes a restore manifest). `--undo` reads the manifest and restores by sha256 match — refuses to overwrite files modified after the migrate. Covers `package.json` (dependency sections with operator preservation), shell scripts, Makefiles, GitHub Actions yaml, Dockerfiles (including CMD-array `["guardrail", "verb"]` form). Skips `node_modules/`, `dist/`, and the tool's own `.claude-autopilot/` state dir.
- **Tombstone `@delegance/guardrail@5.0.0`** package at `packages/guardrail-tombstone/`. Thin CLI wrapper that forwards argv / stdio / exit code / signal to `@delegance/claude-autopilot`. Resolves the child via `createRequire().resolve()` (works under npm / pnpm / yarn / PnP) with two relative-probe fallbacks and a last-resort PATH lookup. Emits a one-line deprecation notice on stderr (silenceable via `CLAUDE_AUTOPILOT_DEPRECATION=never`). Maps ENOENT to exit 127 with an actionable install hint.
- **CI bin-parity workflow** at `.github/workflows/bin-parity.yml`. On every push to master + PR, runs matrix (ubuntu + macos × node 22 + 24) that packs a tarball, globally installs, then asserts: (a) both bins return semver, (b) deprecation notice is on stderr under `always`, (c) deprecation does not leak onto stdout, (d) exit codes match between `claude-autopilot` and `guardrail` on a non-zero-exit invocation. A second job installs from the published `@alpha` tag on push to master for real-world parity.
- **Prefix-hygiene test** at `tests/no-legacy-prefix.test.ts` — asserts that `src/cli/**` uses `[claude-autopilot]` not `[guardrail]`, with an explicit allowlist for legitimate legacy references (bin wrappers, launcher).
- `tsconfig.build.json` — separate build config with `rewriteRelativeImportExtensions: true` and explicit emit settings.
- `scripts/post-build-rewrite-imports.mjs` — defensive rewriter for `.ts` → `.js` import specifiers in emitted JS. No-op when tsc emits correctly.
- `prepublishOnly` script — runs `build && test` before any `npm publish`.
- 14 new tests (migrate-v4: 7, tombstone-bin: 3, no-legacy-prefix: 1, others: 3).

### Changed
- **Error prefixes normalized** — every `[guardrail] ...` error message in `src/cli/index.ts` and `src/cli/preflight.ts` now uses `[claude-autopilot]` or the phase name (`[run]`, `[doctor]`). Legacy `[guardrail]` retained only in the bin-wrapper deprecation notice, `bin/_launcher.js`, and the tombstone package (where it legitimately refers to the deprecated package name).
- **Welcome screen rewritten** — bare `claude-autopilot` invocation now leads with the pipeline pitch (`claude-autopilot brainstorm "..."`) and frames the review subcommands as the v4-compatible alternative. Previously sold the package as "LLM code review."
- **Version resolution in `src/cli/index.ts`** — walks up from `import.meta.url` for the nearest `@delegance/claude-autopilot` `package.json` instead of a hardcoded `../../package.json`. Necessary because the compiled entrypoint lives at `dist/src/cli/index.js` where the old relative path resolved to `dist/package.json` (which doesn't exist).
- **`package.json` `files` field** now includes `dist/` (new) and `scripts/post-build-rewrite-imports.mjs`.
- `preflight.ts`: "Guardrail prerequisite check" heading → "claude-autopilot prerequisite check".

### Fixed
- (None — alpha.3 is feature work; no regressions surfaced by the compat matrix.)

### Still manual for GA
- Alex to publish `@delegance/guardrail@5.0.0` tombstone from `packages/guardrail-tombstone/`.
- Alex to run `npm dist-tag add @delegance/claude-autopilot@5.0.0 latest` once 5.0.0 GA ships.
- Alex to run `npm deprecate @delegance/claude-autopilot@"<5.0.0" "Use @delegance/claude-autopilot@alpha during alpha cycle, or @latest after GA"` to flag pre-rename versions.

## [5.0.0-alpha.2] — 2026-04-24

### Added
- **v4 compatibility assertion matrix** at `tests/v4-compat/` — 20 pinned invocations covering version/help, subcommand routing for all v4 names, deterministic reads (doctor, costs, baseline, explain), flag parsing (`--base`, `--format`, `--fail-on`), deprecation-notice behavior, and the new grouped verbs. Uses marker/regex assertions, not full stdout snapshots — still catches routing and parsing regressions, which is the intent. Full normalized-stdout snapshots for deterministic commands are a follow-up item. Regression of any test blocks future alpha promotion.
- **Superpowers peer-dep detection** — `doctor` now reports a warn-level check for `superpowers:writing-plans`, `superpowers:using-git-worktrees`, `superpowers:subagent-driven-development`. Missing skills produce an actionable remediation hint (`claude plugin install superpowers`). Treated as warn not fail because review-only users don't need it; pipeline phases will hard-fail at their own entry point.
- **Grouped CLI verbs (phase 1: additive aliases)** — `claude-autopilot review <verb>` accepts `{run, scan, ci, fix, baseline, explain, watch, report}`. `claude-autopilot advanced <verb>` accepts `{lsp, mcp, worker, autoregress, test-gen, hook, detector, ignore}`. Both are additive aliases — flat forms (`claude-autopilot run`) continue to work unchanged. Broader restructuring (pipeline verbs `migrate`/`validate` top-level, `pr {create,comment,desc}`) is a later-alpha item.
- **`peerDependencies.superpowers`** (optional) declared in `package.json`.
- `src/cli/preflight.ts`: `findMissingSuperpowersSkills()` exported with recursive search across `~/.claude/plugins/**` and project-local `.claude/plugins/**`.

### Fixed
- **`--help` / `-h` routed to `run`** (latent v4 bug). v4's dispatcher defaulted the subcommand to `run` when `args[0]` started with `--`, so `guardrail --help` silently executed a review instead of printing help. v5.0.0-alpha.2 intercepts `--help`/`-h` before subcommand defaulting and routes to the help handler. Surfaced by the new v4 compat matrix.
- **`--help` output missing 8 v4 subcommands** — `setup`, `preflight`, `hook`, `baseline`, `triage`, `pr-desc`, `council`, `mcp` were listed in the `SUBCOMMANDS` array but not in `printUsage()`. Help now lists all 20+.

### Changed
- README install instructions now pin `@alpha` explicitly for the v5 alpha cycle. The npm `latest` tag still points at a pre-rename 2.5.0 release; without pinning, bare installs silently regress to old code. When 5.0.0 GA ships, `latest` advances and the `@alpha` pin becomes optional.
- Migration guide updated with the `@alpha` pinning note for `npm install`, GitHub Actions, and Dockerfile examples.

### Still deferred to alpha.3
- Tombstone `@delegance/guardrail@5.0.0` with thin CLI wrapper and strict argv/stdio passthrough.
- CI bin-parity smoke tests (`npx guardrail`, `npx @delegance/guardrail`, global install, GitHub Actions).
- Codemod script `claude-autopilot migrate-v4 [--write]`.
- Compiled JS entrypoint (drops `tsx` runtime dep).

## [5.0.0-alpha.1] — 2026-04-24

**Package renamed: `@delegance/guardrail` → `@delegance/claude-autopilot`.**

The v4 product sold itself as "LLM code review." The real product is an end-to-end autonomous development pipeline built on Claude Code skills — brainstorm → spec → plan → implement → migrate → validate → PR → review → merge. This alpha corrects the identity mismatch without breaking any v4 usage.

Every v4 invocation continues to work through v5.x via the preserved `guardrail` CLI alias. Migration guide: `docs/migration/v4-to-v5.md`.

### Added
- **`claude-autopilot` CLI binary** — primary entrypoint (`bin/claude-autopilot.js`), co-installed with `guardrail`.
- **Pipeline skills bundled in the tarball** — `skills/claude-autopilot.md` (agent-loop spec), `skills/autopilot/`, `skills/migrate/`. v4.3.1 shipped only `skills/guardrail.md`; the pipeline skills existed only in-repo and weren't distributed.
- **`generic` preset** — no DB migration runner, uses `npm test` / `npm run typecheck` / `npm run lint` where present. Picked by `detectProject()` as the fallback when no stack signals are found (replaces the v4 behavior of claiming `nextjs-supabase` with low confidence).
- **v5 migration guide at `docs/migration/v4-to-v5.md`** — find/replace patterns for `package.json`, shell scripts, GitHub Actions yaml, Dockerfiles, and Claude Code skills.

### Changed
- **Stack detector fallback:** plain Next.js with no Supabase signals now returns `generic`, not `nextjs-supabase (low confidence)`. Fixes the cold-start eval reviewer finding.
- **`PRESET_LABELS` in `setup.ts`:** adds `generic` entry.
- **Detector tests:** updated to assert the new `generic` fallback behavior.
- **`skills/guardrail.md`:** rewritten as a back-compat alias pointing at `skills/claude-autopilot.md`.
- **`bin/guardrail.js`:** emits a one-line deprecation notice on `stderr` on first invocation per terminal session, then forwards unchanged.

### Deferred to later alphas
- **alpha.2:** full CLI verb restructure (`claude-autopilot {review,pr,triage,advanced,…}`), v4 compatibility golden-test matrix, superpowers peer-dep hard-fail in `doctor`.
- **alpha.3:** tombstone `@delegance/guardrail@5.0.0` publish, CI smoke tests for `npx guardrail` / `npx @delegance/guardrail` / global install / GitHub Actions parity, codemod script for find/replace migration.
- **5.0.0 GA:** after alpha.3 soaks against delegance-app for 2+ real feature pipelines.

## [4.3.1] — 2026-04-24

### Fixed (from external cold-start review)
- **`parseReviewOutput` silent failure** — regex required literal `### [CRITICAL]` brackets and returned zero findings when the LLM emitted `### CRITICAL`, `### **CRITICAL**`, or `### **[CRITICAL]**` (all common Llama/GPT variants). `src/adapters/review-engine/parse-output.ts` now accepts all four formats and logs a warning when raw output is non-empty but no findings parse, so format drift never silently hides bugs again.
- **Pipeline short-circuit skipped LLM review** — `src/core/pipeline/run.ts` returned early on static-rules `fail`, meaning the LLM never ran on the code that most needed it (IDOR, TOCTOU, CORS, off-by-one, rate-limit gaps typically ride alongside a static-flagged issue). New default: review runs even on static-fail. Legacy behavior restored via `pipeline.runReviewOnStaticFail: false` in config.
- **`doctor` / `preflight` ignored 3 of 5 LLM keys** — only checked `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, so users with `GROQ_API_KEY`/`GEMINI_API_KEY`/`GOOGLE_API_KEY` set saw "No LLM API key" right after `setup` reported "detected." New shared helper `src/core/detect/llm-key.ts` is the single source of truth used by setup, scan, run, and preflight.
- **Stack detector mislabeled plain Next.js as "Next.js + Supabase"** — now requires actual Supabase signals (`@supabase/supabase-js`, `@supabase/ssr`, `@supabase/auth-helpers-nextjs`, `supabase/config.toml`, or `SUPABASE_*` env vars). Vanilla Next.js still uses the `nextjs-supabase` preset as a fallback but the evidence string and setup output make the fallback explicit.
- **`--profile team` missing security rules** — added `package-lock-sync`, `ssrf`, `insecure-redirect` to match the README's advertised coverage.

### Added
- `src/core/detect/llm-key.ts` — `detectLLMKey()`, `LLM_KEY_NAMES`, `LLM_KEY_HINTS`, `loadEnvFile()`.
- `GuardrailConfig.pipeline.runReviewOnStaticFail` / `runReviewOnTestFail` config flags.
- 6 parser format-variation tests covering all documented markdown variants plus the silent-drift warning path.

## [2.5.0] — 2026-04-22

### Added
- **Config schema validation** — `ignore:` and `reviewStrategy: diff|auto-diff` now accepted; unknown keys reported as `unexpected key "<name>"`; enum errors list allowed values; error message includes up to 5 violations with field paths
- **`autopilot fix`** — reads `.autopilot-cache/findings.json`, asks the configured LLM to rewrite the ±20 lines around each finding, applies patches in place; `--severity critical|warning|all` (default: critical); `--dry-run` previews without writing; exits 1 if any fix fails
- **`autopilot costs`** — prints all-time run count + spend, 7-day summary, and a last-10-runs table (date, files, tokens in/out, cost, duration)
- `src/cli/fix.ts` — `runFix()`; sends numbered context window to LLM with fix instructions; strips markdown fences from response; handles `CANNOT_FIX` sentinel gracefully
- `src/cli/costs.ts` — `runCosts()` reading `.autopilot-cache/costs.jsonl`
- 9 new tests — **266 total**

## [2.4.0] — 2026-04-22

### Added
- **`ignore:` config key** — embed suppression rules in `autopilot.config.yaml` via `ignore: ['tests/**', { rule: hardcoded-secrets, path: src/vendor/** }]`; merged with `.autopilot-ignore` file rules at run time
- **Per-run cost log** — appends `{timestamp, files, inputTokens, outputTokens, costUSD, durationMs}` to `.autopilot-cache/costs.jsonl` after every run; corrupt lines skipped on read; `readCostLog()` exported for tooling
- **`--inline-comments`** — posts a GitHub PR review with per-line inline comments for every finding that has a `file:line`; re-runs dismiss the previous autopilot review before posting a new one; `autopilot ci` enables this by default (`--no-inline-comments` to opt out)
- **`reviewStrategy: auto-diff`** — tries diff first, falls back to full-file `auto` when diff is empty (new files, no git history); `--diff` flag still forces pure diff mode
- `src/cli/pr-review-comments.ts` — `postReviewComments()` using `gh api repos/{nwo}/pulls/{pr}/reviews`
- `src/core/persist/cost-log.ts` — `appendCostLog()`, `readCostLog()`
- 9 new tests — **257 total**

## [2.3.0] — 2026-04-22

### Added
- **Parallel chunk review** — file-level chunks are now reviewed concurrently (default parallelism: 3, configurable via `chunking.parallelism`); serial fallback preserved when `cost.budgetUSD` is set so budget enforcement remains accurate
- **`.autopilot-ignore`** — project-level suppression file; format: `<rule-id> <glob>` or bare `<glob>` (matches any finding on that path); comments and blank lines ignored; suppressed count printed dim after run
- **`--delta` mode** — only reports findings new since the previous run; pre-existing findings are hidden and the count is printed dim; findings always persisted to `.autopilot-cache/findings.json` after each run (gitignored)
- `src/core/ignore/index.ts` — `loadIgnoreRules()`, `applyIgnoreRules()`
- `src/core/persist/findings-cache.ts` — `loadCachedFindings()`, `saveCachedFindings()`, `filterNewFindings()`
- 15 new tests — **248 total**

## [2.2.0] — 2026-04-22

### Added
- **`reviewStrategy: diff`** — new chunking strategy that sends `git diff` unified hunks instead of full file contents; typically ~70% fewer tokens and more focused findings (LLM sees exactly what changed)
- **`--diff` flag** on `run` and `ci` subcommands — shorthand to activate diff strategy without editing config
- **`src/core/git/diff-hunks.ts`** — `getFileDiffs()`, `parseUnifiedDiff()`, `formatDiffContent()`; per-file diff sections in fenced code blocks; files that exceed `maxChars` are omitted with a count notice
- `BuildChunksInput.base` / `ReviewPhaseInput.base` / `RunInput.base` — threads git base ref through pipeline to diff engine
- 9 new tests for `parseUnifiedDiff` and `formatDiffContent` — **233 total**

## [2.1.0] — 2026-04-22

### Added
- **Risk-weighted file ordering** (`src/core/chunking/risk-ranker.ts`) — ranks files before sending to LLM: protected paths (score 100) → auth/security (80) → payment/billing (70) → core logic (50) → config files (40) → everything else (30) → tests (10) → docs (5); ensures most sensitive code appears at the start of the LLM's context window
- `BuildChunksInput.protectedPaths` — passed from config through review-phase to ranker so glob patterns from `protectedPaths:` config key are respected
- 9 new tests for `rankByRisk` — **224 total**

## [2.0.0] — 2026-04-22

### Added
- **`autopilot ci`** — opinionated single-command CI entrypoint; defaults to `--post-comments`, `--format sarif`, and base ref from `GITHUB_BASE_REF`/`CI_MERGE_REQUEST_TARGET_BRANCH_NAME`/`HEAD~1`; supports `--base`, `--output`, `--no-post-comments`
- **`.github/actions/ci/action.yml`** — composite GitHub Actions action; accepts `anthropic-api-key`, `openai-api-key`, `gemini-api-key`, `groq-api-key`, `base-ref`, `config`, `sarif-output`, `post-comments` inputs; runs `npx autopilot ci`, uploads SARIF via `codeql-action/upload-sarif@v3`
- **Updated `skills/autopilot.md`** — complete rewrite covering all adapters, auto-detection, `--post-comments`, `ci` command, action.yml usage

## [1.9.0] — 2026-04-22

### Added
- **`--post-comments` flag on `run`** — posts a formatted markdown summary to the open PR after the pipeline; edits existing autopilot comment on re-runs instead of creating a new one (tracked via `<!-- autopilot-review -->` marker)
- **`detectPrNumber()`** — reads `PR_NUMBER`/`GH_PR_NUMBER`/`GITHUB_PR_NUMBER` env vars (CI) or falls back to `gh pr view` (local)
- **`formatComment()`** — status badge, context line, phase table, critical/warning findings with `file:line`, notes in `<details>`, cost footer
- 10 new formatter tests — **215 total**

## [1.8.0] — 2026-04-22

### Added
- **Shared `parseReviewOutput()`** (`src/adapters/review-engine/parse-output.ts`) — extracts `file:line` attribution from review finding bodies; used by all five adapters; eliminates ~100 lines of duplicated parser code

### Fixed
- `hardcoded-secrets` false positive on route object keys containing `password` (e.g. `forgot_password: '/forgot-password'`)

## [1.7.2] — 2026-04-22

### Fixed
- `hardcoded-secrets` rule no longer fires on route path values (values starting with `/`)

## [1.7.1] — 2026-04-22

### Added
- Detection logging: `auto-detected:` line in run output shows stack, protected paths, and test command when inferred; git context (branch + last commit) shown on every run

## [1.7.0] — 2026-04-22

### Added
- **Stack auto-detection** (`src/core/detect/stack.ts`) — infers human-readable stack string from `package.json`, `go.mod`, `Cargo.toml`, `requirements.txt`, `Gemfile`; detects framework, ORM, auth, UI library, language; injected into review prompt automatically when `stack:` is absent from config
- **Protected-paths auto-detection** (`src/core/detect/protected-paths.ts`) — scans for migration dirs (`data/deltas/`, `migrations/`, `db/migrate/`, `prisma/migrations/`, `alembic/versions/`, `flyway/`), schema files (`schema.prisma`, `schema.sql`, `db/schema.rb`), infra dirs (`terraform/`, `k8s/`, `helm/`, `.github/workflows/`); populates `protectedPaths` when not set in config
- **Test-command runtime fallback** — re-runs project detector at `run` time when `testCommand` is absent from config; `null` still disables the test phase explicitly
- **Git context enrichment** (`src/core/detect/git-context.ts`) — injects branch name and last commit message into the review prompt as `Change context: branch: feat/x | last commit: add user auth` so the LLM understands intent
- `ReviewInput.context.gitSummary` — new context field; all five adapters (claude, gemini, codex, openai-compatible, auto) inject it when present
- 18 new tests (9 stack + 9 protected-paths) — **199 total**

## [1.6.0] — 2026-04-22

### Added
- **Provider usage scanner** (`src/core/detect/provider-usage.ts`) — walks project source files, counts per-provider API key and SDK references (capped at 1 per file to avoid skew), returns `ProviderCounts`
- **`dominantProvider()`** — returns the provider with the highest file-reference count
- **Smart `auto` tiebreaker** — when multiple API keys are present, `auto` scans the codebase and prefers the provider already used there; falls back to env-key priority order if counts are all zero
- `ReviewInput.context.cwd` — threads working directory through to the review engine so `auto` knows where to scan; `review-phase.ts` now passes `cwd` in context
- 12 new tests for `detectProviderUsage` and `dominantProvider` — **181 total**

## [1.5.0] — 2026-04-22

### Added
- **Gemini adapter** (`gemini`) — Google Gemini 2.5 Pro via `@google/generative-ai`; accepts `GEMINI_API_KEY` or `GOOGLE_API_KEY`; 1M token context window
- **OpenAI-compatible adapter** (`openai-compatible`) — works with any OpenAI-API-compatible endpoint (Groq, Ollama, Together AI, etc.); requires `options.model`; auto-selects API key via `options.apiKeyEnv` → `OPENAI_API_KEY` → `'ollama'`
- **Updated auto adapter** — full priority chain: `ANTHROPIC_API_KEY` → `GEMINI_API_KEY`/`GOOGLE_API_KEY` → `OPENAI_API_KEY` → `GROQ_API_KEY` (wraps openai-compatible with Groq config)
- `run.ts` no-key warning now lists all four key options

### Changed
- 169 tests total (up from 136)

## [1.4.0] — 2026-04-21

### Added
- **Static rules registry** (`src/core/static-rules/registry.ts`) — lazy-loads built-in rules by name; fixes critical bug where config `staticRules` was always silently ignored
- **7 built-in rules**: `hardcoded-secrets`, `npm-audit`, `package-lock-sync`, `console-log`, `todo-fixme`, `large-file`, `missing-tests`
- **Claude adapter** (`claude`) — Anthropic Claude Opus 4.7 via `@anthropic-ai/sdk`; configurable model via `context.model`
- **Auto adapter** (`auto`) — detects best available key at runtime; checked in priority order
- `doctor` now checks `ANTHROPIC_API_KEY` in addition to `OPENAI_API_KEY`
- 136 tests total

### Fixed
- **Critical**: `staticRules` in `RunInput` was never populated — config-listed rules were silently ignored. `loadRulesFromConfig()` now wired into `run.ts`

## [1.2.8] — 2026-04-21

### Added
- 8 new tests covering npm placeholder detection, pyproject.toml FastAPI detection, `resolveGitTouchedFiles` ignore list, deduplication, and status fallback — **136 total**

## [1.2.7] — 2026-04-21

### Fixed
- `autopilot run` now loads `.env.local` / `.env` at startup so `OPENAI_API_KEY` (and other env vars) are available without exporting them in the shell first

## [1.2.6] — 2026-04-21

### Added
- `skills/autopilot.md` included in npm package — install once, then `cp node_modules/@delegance/claude-autopilot/skills/autopilot.md .claude/skills/` to give Claude Code full context on when and how to invoke the CLI

## [1.2.5] — 2026-04-21

### Added
- `--version` / `-v` flag — prints package version and exits
- Built-in ignore list for git diff output: `node_modules/`, `dist/`, `build/`, `.next/`, `.nuxt/`, `out/`, `coverage/`, `.turbo/`, `.cache/`, `vendor/`, `__pycache__/`, `.venv/`, `venv/`, `target/`, `.gradle/` — prevents build artifact floods from polluting the changed-files list

## [1.2.4] — 2026-04-21

### Changed
- `autopilot init` is now deprecated — prints a notice and delegates to `autopilot setup`

### Fixed
- Removed superpowers plugin check from `doctor` — it was warning all external developers about a Delegance-internal tool they cannot install

## [1.2.3] — 2026-04-21

### Fixed
- README rewrite: `setup` and `doctor` commands now prominent; config schema accurate; public API section added

## [1.2.2] — 2026-04-21

### Fixed
- Hook install called from `setup` no longer double-prints stderr; added `silent` option to `runHook()` to suppress output when invoked programmatically

## [1.2.1] — 2026-04-21

### Fixed
- `bin/autopilot.js` tsx resolution now checks the consumer's `node_modules/.bin/tsx` before falling back to PATH — fixes "tsx not found" on fresh installs
- npm default test placeholder (`echo "Error: no test specified" && exit 1`) is now detected and replaced with `npm test` instead of being used as the test command

## [1.2.0] — 2026-04-21

### Added
- `autopilot doctor` — prerequisite checker: verifies Node 22+, tsx, gh CLI auth, claude CLI, OPENAI_API_KEY, git config, superpowers plugin; shows exact fix command for each failure; exits 1 if any blockers
- `autopilot setup` now runs `doctor` automatically at the end so users immediately see what still needs attention
- `autopilot preflight` kept as alias for `doctor`

## [1.1.0] — 2026-04-21

### Added
- `autopilot setup` — zero-prompt setup: auto-detects project type (Go, Rails, FastAPI, T3, Next.js+Supabase), infers test command, writes config, installs git hook in one command
- `autopilot setup --force` — overwrite existing config

## [1.0.2] — 2026-04-21

### Fixed
- README: install command updated (`--save-dev` removed, `@alpha` tag removed); hard prerequisites documented
- preflight: tsx missing message no longer suggests `--save-dev` (tsx is now a runtime dependency)

## [1.0.1] — 2026-04-21

### Fixed
- Move `tsx`, `js-yaml`, `ajv`, `dotenv`, `minimatch`, `openai` from `devDependencies` to `dependencies` — CLI was broken for end-users who installed via npm since devDeps aren't installed by consumers

## [1.0.0] — 2026-04-21

### Changed
- Promoted from 1.0.0-rc.1 — no new changes, stable release

## [1.0.0-rc.1] — 2026-04-21

### Added
- `autopilot init` now shows full next-steps: hook install, autoregress generate, CI snippet, first run
- Public API surface: `Finding`, `RunResult`, `AutopilotConfig`, `normalizeSnapshot` exported from package root via `exports` field in package.json

### Changed
- Version promoted from 1.0.0-alpha.8 → 1.0.0-rc.1

## 1.0.0-alpha.8

### Added

- **`autopilot autoregress`** — `autoregress run|diff|update|generate` now a first-class `autopilot` subcommand (no more raw `npx tsx scripts/autoregress.ts`)
- **GitHub Actions CI** — `.github/workflows/ci.yml` runs typecheck + tests on every PR; auto-publishes to npm on `v*` tags
- **README rewrite** — full feature documentation covering all alphas (all commands, config, GitHub Actions, snapshot regression, architecture)

## 1.0.0-alpha.7

### Added

- **`autopilot hook install`** — writes a `pre-push` git hook that runs `autoregress run` before every push; `hook uninstall` removes it; `hook status` shows current state; `--force` overwrites existing hook
- **`autoregress diff`** — colored snapshot viewer showing line-by-line JSON diffs between current output and baselines; exits 1 if any diffs found (never modifies baselines — use `update` for that)
- **`autoregress generate --files <list>`** — explicit comma-separated file list bypasses git detection; generates baselines for any src file on demand
- **Real baselines** — `tests/snapshots/*.snap.ts` + baselines for `serializer.ts`, `import-scanner.ts`, `impact-selector.ts`, and `sarif.ts` — alpha.6 infrastructure now self-testing via snapshots

## 1.0.0-alpha.6

### Added

- **Auto-regression testing** (`scripts/autoregress.ts generate|run|update`) — autoresearch-inspired snapshot tests for changed source modules
- **Impact-aware selection** — only fires snapshots whose source modules (or one-hop importers) were touched; high-impact paths (`src/core/pipeline/**`, `src/adapters/**`, `src/core/findings/**`, `src/core/config/**`) and >10-file changes trigger full run
- **Snapshot serializer** (`src/snapshots/serializer.ts`) — deterministic JSON normalization: sorted keys, `<timestamp>`, `<uuid>`, path stripping
- **Import scanner** (`src/snapshots/import-scanner.ts`) — static `import`/`export` graph → reverse dependency map
- **Impact selector** (`src/snapshots/impact-selector.ts`) — merge-base diff + one-hop expansion + overrides
- **Baseline capture** — `CAPTURE_BASELINE=1` env flag; `autoregress update` rewrites baselines after intentional changes
- **Staleness detection** — warns and skips snapshots whose `@snapshot-for` source file no longer exists
- 10 new unit tests (AR1-AR10) for serializer, import scanner, and impact selector

## 1.0.0-alpha.5 (2026-04-21)

### New Features

- **`--format sarif --output <path>`** on `autopilot run` — serialises `RunResult` to SARIF 2.1.0; deduplicates rules by category; normalises URIs to repo-relative forward-slash; always emits `results: []` even on error so `upload-sarif` never fails on a missing file
- **Auto GitHub Actions annotations** — when `GITHUB_ACTIONS=true`, `emitAnnotations()` fires after every run and writes `::error`/`::warning`/`::notice` workflow commands to stdout; GitHub renders these as inline annotations on the PR diff
- **`src/formatters/`** — pure formatter modules (`sarif.ts`, `github-annotations.ts`) with full command-injection encoding (`%`, `\r`, `\n`, `:`, `,`) for annotation properties and data
- **`action.yml`** composite action — checkout → setup-node@v4 → npx autopilot run → upload-sarif@v3; inputs: `version`, `config`, `sarif-output`, `openai-api-key`; upload step runs `if: always()` so findings surface even when run exits 1
- 21 new formatter tests (11 SARIF + 10 annotations) → **95 total**

## 1.0.0-alpha.4 (2026-04-21)

### New Features

- **`autopilot watch`** (`src/cli/watch.ts`) — watches cwd recursively, debounces file changes (default 300ms), re-runs `runAutopilot()` on each batch, prints phase summary per run; Ctrl+C exits cleanly
- **`--debounce <ms>`** flag on `watch` subcommand
- **`makeDebouncer`** and **`isIgnored`** exported as pure functions (testable without real watcher)
- **`files` field** in package.json — excludes tests, restricts publish to `bin/`, `src/`, `presets/`, `scripts/test-runner.mjs`, `CHANGELOG.md`
- **`private: true` removed** — package is now publishable to npm
- **`engines.node: >=22.0.0`**, `keywords`, `license`, `repository` added to package.json
- 12 new watch tests (7 isIgnored + 5 debouncer) → 74 total

## 1.0.0-alpha.3 (2026-04-21)

### New Features

- **`autopilot run`** (`src/cli/run.ts`) — runs the full pipeline from the terminal: loads config, resolves preset, auto-detects changed files via git diff, calls `runAutopilot()`, prints phase summary with inline finding details
- **`autopilot init`** (`src/cli/init.ts`) — interactive preset scaffold: lists 5 presets, writes `autopilot.config.yaml`, prints next steps
- **`autopilot preflight`** — re-routes to existing preflight checker
- **Git touched-files resolver** (`src/core/git/touched-files.ts`) — `resolveGitTouchedFiles()` diffs HEAD~1..HEAD, falls back to `git status` for single-commit repos; configurable `--base` ref
- **CLI entrypoint** (`src/cli/index.ts`) — dispatches to init/run/preflight subcommands; supports `--base`, `--config`, `--files`, `--dry-run` flags
- **`bin.autopilot`** restored in `package.json` pointing at the new entrypoint
- 10 new CLI tests (5 touched-files, 5 run-command) → 62 total

## 1.0.0-alpha.2 (2026-04-20)

### New Features

- **Run pipeline orchestrator** (`src/core/pipeline/run.ts`) — top-level `runAutopilot()` sequences static-rules → tests → review phases with fail-fast semantics and cost accumulation
- **2-tier chunking** (`src/core/chunking/`) — `auto` strategy selects single-pass (≤8K tokens) or file-level (≤60K); `single-pass` and `file-level` strategies configurable via `reviewStrategy`
- **Cost visibility** — `costUSD` accumulated across review phase, surfaced in `RunResult.totalCostUSD`; optional `cost.budgetUSD` threshold emits warning and skips remaining chunks when exceeded
- **Review-engine response cache** (`src/core/cache/`) — file-based SHA-256 cache with configurable TTL; `withCache()` wraps any `ReviewEngine`; atomic writes (tmp+rename)
- **4 new presets** — `t3` (Next.js + tRPC + Prisma), `rails-postgres`, `python-fastapi`, `go`; each ships a stack.md and at least one stack-specific static rule
- **20 scenario tests** (`tests/scenarios/run-pipeline.test.ts`) — covers fail-fast, autofix, budget, chunking strategies, preset loading

### Fixes

- `finalize()` now trusts per-phase status (which accounts for autofixes) instead of re-deriving from raw `allFindings` severity
- Test script glob changed to `find tests -name '*.test.ts' | xargs` to pick up nested scenario tests

## 1.0.0-alpha.1 (2026-04-20)

Initial release — core infrastructure: adapter interfaces, config system, preflight CLI, static-rules phase with autofix, tests phase, Codex/GitHub/Supabase/Cursor adapters, nextjs-supabase preset, 32 unit tests.
