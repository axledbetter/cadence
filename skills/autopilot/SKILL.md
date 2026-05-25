---
name: autopilot
description: End-to-end pipeline — brainstorm → spec → plan → implement → validate → migrate dev → PR → Codex review → bugbot → merge. Risk-tiered. No manual intervention after spec approval until PR merge; production deploy/migration gates are handled by the user's CI/CD pipeline.
---

# Autopilot — Idea to Merged PR Pipeline

Drives the full flow from raw user idea (or an existing spec) through merged PR. The ONLY pause is explicit user approval of the spec after Step 0; everything after that runs unattended unless blocked by an unrecoverable failure, missing credentials, or an unresolved CRITICAL Codex finding.

## Entry decision tree

Pick the entry point ONCE at the start:

- **Approved spec path provided** (e.g. `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`) → skip Step 0, jump to Step 1.
- **Only an idea provided** (no spec) → run Step 0 to brainstorm + spec it.
- **Neither** → ask the user once for either the spec path or the idea. This is the only allowed pre-pipeline pause.

## Prerequisites (hard-gate)

The pipeline ABORTS with a clear actionable error if any of these are missing:

- **Required skills:** `superpowers:brainstorming`, `superpowers:writing-plans`, `superpowers:subagent-driven-development`, `superpowers:using-git-worktrees` (for Step 2)
- **Required project scripts:** `scripts/codex-review.ts`, `scripts/codex-pr-review.ts`, `scripts/bugbot.ts`, `scripts/validate.ts` — OR equivalent CLI verbs from `@delegance/cadence` (formerly `@delegance/claude-autopilot`) if running the package version
- **Required env:** `OPENAI_API_KEY` (for Codex passes), `GITHUB_TOKEN` or `gh auth status` (for PR creation), `ANTHROPIC_API_KEY` (for impl agents)

If any superpowers skill is missing, print:
```
Autopilot requires superpowers plugin. Install with: claude plugin install superpowers
```
and exit. Do NOT half-run with a missing dependency.

## Operational preflight (run before Step 0/1)

Each numbered check below is a HARD GATE. ALL must pass before any LLM call. There are no "OR" conditions — every condition listed inside a check must hold.

1. **Branch is NOT `main`/`master`** — independent hard gate. Run `git rev-parse --abbrev-ref HEAD`; if the result is `main` or `master`, ABORT immediately. The skill never commits or mutates `main`/`master` directly. Resolution: create a feature branch or worktree first.
2. **Working tree is clean (tracked AND untracked)** — `git diff --quiet` AND `git diff --cached --quiet` must both succeed. Run `git status --porcelain`; abort if any untracked files are present unless the user explicitly opted in via `--allow-untracked`.
3. **GitHub auth resolved** — accept ANY of:
   - `gh auth status` succeeds (interactive CLI login), OR
   - `GITHUB_TOKEN`/`GH_TOKEN` is set AND `gh api user` (using that token) returns 200.

   Then verify push permission for the target repo: `gh repo view <owner>/<repo>` succeeds AND either (a) `gh api repos/<owner>/<repo>/collaborators/<user>/permission` returns `admin`/`maintain`/`write`, or (b) a no-op `git push --dry-run origin HEAD:refs/heads/<probe-branch>` succeeds. Abort if no push permission.
4. **Codex CLI resolution** — Resolve the codex-review command ONCE here and cache the resolved invocation for the rest of the pipeline. Try in order:
   - `npx tsx scripts/codex-review.ts --help` (project-local script), OR
   - `npx @delegance/cadence codex-review --help` (package CLI, also exposes `codex-pr-review`, `bugbot`, `validate`), OR
   - `npx @delegance/claude-autopilot codex-review --help` (legacy package name, deprecated since v8.0.0 but still installable).

   Use whichever resolves first; cache the resolved command. Abort if neither does. The accepted package CLI verbs are: `codex-review`, `codex-pr-review`, `bugbot`, `validate` — pinned to the major version of `@delegance/cadence` (or legacy `@delegance/claude-autopilot`) declared in the host project's `package.json`.
5. **Test runner reachable** — Detect from `package.json`: if `scripts.test` is defined, run `npm run test -- --help` or framework-specific probe (`vitest --version`, `jest --help`, `playwright --version`). Do NOT assume `--dry-run` is supported. If no `test` script exists, accept presence of `scripts/validate.ts` or `scripts.validate` instead. Abort only if neither test nor validation entrypoint is reachable.
6. **Implementation-agent credentials present** — `ANTHROPIC_API_KEY` is required because the skill drives Claude Code subagents for implementation; this is independent of which provider the host project uses for application LLM calls. If your impl-agent backend is intentionally non-Anthropic, document the override in `.claude/autopilot.config.json` and the preflight will accept the configured alternative.
7. **Migration tool reachable** (if `data/deltas/` exists) — `/migrate` skill or `supabase` CLI

If any preflight check fails, abort with the specific check and remediation hint. Do NOT proceed and discover the failure mid-pipeline.

**Risk-tier confirmation is preflight, not mid-pipeline.** If the entry path is an approved spec and the spec's frontmatter is missing `risk:`, run the keyword auto-escalation rule (see below) and surface the inferred tier as a single preflight prompt BEFORE Step 1 begins. This is the same pre-pipeline pause class as "ask for the spec path"; it is not a mid-pipeline check-in.

## CRITICAL invariant — Do Not Pause (after spec approval)

There are exactly TWO allowed pre-pipeline pause classes, both occurring BEFORE Step 1:

1. **Step 0 brainstorming user input** — the user picks an approach in substep 1 and explicitly approves the final spec at the end. These are intrinsic to brainstorming, not mid-pipeline check-ins.
2. **Preflight prompts** — missing entry inputs (spec path or idea), and risk-tier confirmation when frontmatter is missing `risk:`. These resolve before Step 1 starts.

After Step 1 begins, do NOT:

- Ask "want me to continue?" between steps
- Show intermediate results or ask for confirmation
- Pause to report progress mid-pipeline
- Wait for user input between any steps

The pipeline halts ONLY for:
- Unrecoverable step failure (retries exhausted)
- Missing credentials surfaced mid-run (despite preflight)
- An **unresolved CRITICAL Codex finding** (see acceptance rules below)
- An external system hard-block (TCC permission revoked, network outage, etc.)

Brief status lines like `[autopilot] Step 3: Executing plan...` are fine. Full summaries, questions, or check-ins are not. Report ONCE at the end (Step 9).

## Codex pass policy (risk-tiered)

> Adopted from the v7.4.1 strategic review. The v8 spec pass-2
> finding 3 CRITICALs the original spec missed (sandbox / credential
> exfiltration) was concrete evidence that 1 codex pass is
> insufficient for security-sensitive architecture. But running 3
> passes on every CLI polish spec adds latency without value.

**Specs must declare risk in YAML frontmatter:**
```yaml
---
title: <spec title>
risk: low | medium | high
---
```

**Pass-count rules:**

| Spec risk | Triggers | Codex passes (idea-entry) | Codex passes (approved-spec-entry) |
|---|---|---|---|
| **Low** | CLI UX, doc-only PRs, scaffolding extensions, config polish, CI workflow tweaks | **1 pass** on the committed spec | **1 pass** on the committed spec (Step 1) |
| **Medium** | New execution modes, auth changes, billing flows, data-access patterns, new env vars, API contracts | **2 passes** (1 draft in Step 0, 1 on merged spec in Step 1) + Step 7 PR review | **2 passes** on the committed spec in Step 1 (back-to-back, with remediation between) + Step 7 PR review |
| **High** | Sandboxing, multi-tenancy, auto-merge, repo mutation, new secrets handling, RPC/SECURITY DEFINER changes | **3 passes** (1 draft, 1 post-edit in Step 1, 1 pre-impl) + Step 7 PR review | **3 passes** on the committed spec in Step 1 (each followed by remediation) + Step 7 PR review |

**Entry-path semantics:** When entering with an approved spec (no Step 0 draft pass available), run the full required pass count starting in Step 1, applying remediation and re-running until CRITICALs are clean. Optionally, the spec may declare prior Codex passes in frontmatter (`codex_passes_completed: <n>`) to credit toward the requirement.

**Backward-compatibility for missing `risk:`:**

If the spec frontmatter is missing `risk:`, default to `medium` AND emit a warning. Auto-escalate to `high` only when the spec content crosses a trust boundary — match on these specific phrases (not the bare word `auth`, which is too broad and conflicts with the medium-risk "auth changes" classification in the table above):

- `multi-tenant`, `tenancy`, `RLS bypass`, `SECURITY DEFINER`
- `secret handling`, `credential handling`, `vault`, `token storage`, `session token`
- `auto-merge`, `automerge`, `sandbox`, `sandboxed`
- `SSO provisioning`, `SAML assertion`, `OAuth provider integration`, `privilege escalation`
- `repo mutation`, `force-push`

The risk-tier confirmation happens during preflight (see "Risk-tier confirmation is preflight, not mid-pipeline" above), not as a separate mid-pipeline pause.

**Step 0 substep passes are ALWAYS 1 initial pass each, regardless of spec risk.** Brainstorming is draft-stage feedback, not load-bearing security review. The risk-tiered policy applies starting at Step 1 (where the spec is committed). Note that CRITICAL findings in a Step 0 substep still trigger remediation + re-pass per the acceptance rules below — "1 initial pass" means "1 pass to surface findings," not "1 pass total even with unresolved CRITICALs."

## Acceptance rules for Codex findings (CRITICAL — remediation semantics)

This is the load-bearing rule. Misreading it can ship vulnerable code.

- **CRITICAL findings: must be REMEDIATED, not just acknowledged.** Apply the fix to the spec/plan/code, then re-run the Codex pass. The pipeline MAY NOT proceed while any CRITICAL finding remains unresolved. "Auto-accept" never means "continue past."
- **WARNING findings:** remediate by default. Skip ONLY if the finding directly contradicts a locked user requirement; in that case, document the skip in the PR description with the reason.
- **NOTE findings:** discretionary. Roll into a "post-launch follow-ups" appendix if relevant; otherwise ignore.

After each Codex pass, present a single-line summary table to the user (severity + title + remediation status). Do NOT pause for "should I incorporate these?" — apply the rules above and continue.

## Tempfile naming (avoid concurrent-session collisions + secure-by-default)

Codex passes write to temporary input files. Use a per-run isolated directory with restrictive permissions, NOT a shared `/tmp` path:

```
<dir> = mkdtemp("${TMPDIR:-/tmp}/claude-autopilot-XXXXXX")   # mode 0700
<file> = $dir/codex-input-<topic-slug>-<step>.md             # mode 0600, exclusive create (O_EXCL)
```

The timestamp+pid pattern from earlier drafts is INSUFFICIENT — it is predictable, world-readable in shared `/tmp`, and vulnerable to symlink races. Always use `mkdtemp` (or platform-equivalent) to get a randomized, exclusively-created directory before writing the file.

Example resolved path: `/tmp/claude-autopilot-aB3xQ9/codex-input-v8-daemon-step-arch.md`

Rules:
- Use `mkdtemp` (Node: `fs.mkdtempSync(path.join(os.tmpdir(), 'claude-autopilot-'))`) — never a hand-built path
- Set file mode `0600` on creation; set dir mode `0700`
- Clean up the entire temp directory in a `finally` block (success OR failure)
- Specs may contain sensitive architecture details (tenant/RLS behavior, auth flows, schema names, internal endpoints). The "no secrets" rule extends to "no production-sensitive design content in tempfiles you'd be uncomfortable surfacing"; paraphrase such content before writing
- Never write secrets, API keys, or production credentials to tempfiles regardless of location

## DEFAULT: Concurrent multi-PR dispatch when the user supplies multiple independent deliverables

When the user describes multiple independent deliverables in one invocation (e.g., "ship A, B, and C as separate PRs"), dispatch them as **parallel Agent subagent invocations** in a single message — each in its own isolated worktree (`isolation: "worktree"`), each running its own end-to-end pipeline (brainstorm → spec → plan → implement → validate → PR → codex-review → bugbot). Do not serialize them. Concurrent dispatch is the default unless explicit serialization is requested. Only serialize when the user explicitly says so OR the deliverables depend on each other.

### Independence preflight (run before dispatching concurrently)

Before fanning out, do a quick dependency/conflict scan. Serialize (or designate ONE coordinator PR for the shared edit) when any of the following are true for two or more proposed deliverables:

- **Shared release metadata**: root `package.json` version, `package-lock.json`, workspace `package.json` versions, `CHANGELOG.md`, release notes.
- **Shared schema or contracts**: DB migrations (`data/deltas/` or equivalent), RLS policies, generated types (`types/supabase.ts` or equivalent), public API contracts, OpenAPI/JSON schemas.
- **Shared infrastructure**: queue/topic names, env-var registry, shared TypeScript types/interfaces consumed by all PRs, monorepo config (`tsconfig`, `nx.json`, workspace globs).
- **Same module/route**: PRs that all touch the same handler, the same React component tree, or the same service file.

If file ownership across the PRs is genuinely disjoint AND none of the shared-artifact categories above apply, proceed concurrently. Otherwise, either serialize (run sequentially in dependency order) or split out the shared edit into a single coordinator PR that lands first, then dispatch the dependent PRs concurrently against the post-merge base.

### Avoid duplicated global edits across concurrent subagents

When dispatched concurrently, individual feature subagents should NOT independently bump versions, edit `CHANGELOG.md`, regenerate lockfiles, or touch release metadata unless the parent operator has explicitly assigned that edit to exactly one subagent. The default for a fan-out is: feature code only in each subagent; release/version/changelog changes go in a separate coordinator PR or are added by the operator after the fan-out merges. This prevents merge conflicts on global artifacts that are otherwise unrelated to each PR's feature work.

## Step 0: Brainstorming with per-step Codex validation

**Skip this step entirely if a spec already exists.** Otherwise:

Drive `superpowers:brainstorming` from the user's idea. **At each substep below, automatically run `/codex-review` and incorporate findings before moving on.** One pass per substep. Do not wait to be prompted.

Codex-validate after each of these brainstorming substeps:

1. **Approach selection** — after presenting 2–3 approaches and the user picks one, write the chosen approach + rejected alternatives to a tempfile (per pattern above) and run the resolved codex-review command (from preflight, typically `npx tsx scripts/codex-review.ts <tempfile>` for project installs, or the package CLI fallback). Apply CRITICAL findings before proceeding (remediate, then re-pass if needed).
2. **Architecture section** — after presenting the top-level architecture (boxes/arrows + key principles), Codex-validate; remediate CRITICALs.
3. **Components + data flow section** — after detailing components, schemas, and data flow, Codex-validate; remediate CRITICALs.
4. **Error handling + testing section** — after specifying failure modes and test strategy, Codex-validate; remediate CRITICALs.
5. **Prepare final spec draft** — once the spec doc is written and self-reviewed, capture WARNINGs/NOTEs into a "post-launch follow-ups" appendix. (The load-bearing final spec validation happens in Step 1, NOT here — Step 0 produces a draft ready for the risk-tiered pass.)

Each substep uses ONE initial Codex pass for fast design feedback. Additional revalidation passes are required ONLY when CRITICAL findings are remediated (per the acceptance rules above) — "one initial pass" is not a cap on re-passes after remediation.

**Exit Step 0 with:**
- Committed spec at `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- Spec includes `risk: low|medium|high` in frontmatter (or accept the default-medium per the backward-compat rule)
- User has explicitly approved the spec (this is the ONLY allowed pause in the entire pipeline)

## Pipeline

Execute these steps in order. Do NOT pause between steps unless a step fails per the acceptance rules.

### Step 1: Risk-tiered final spec validation + write implementation plan

**First — risk-tiered pass on the committed spec** per the policy table above:
- Low risk: 1 pass on the spec
- Medium risk: 2 passes (this one + Step 7 codex PR review serves as pass 2)
- High risk: 3 passes (this + Step 7 + an explicit pre-implementation pass)

Remediate CRITICALs in-place on the spec before moving on.

**Then write the plan:**
```
Invoke: superpowers:writing-plans
Input: The approved + validated spec
Output: Plan at docs/superpowers/plans/YYYY-MM-DD-<topic>.md
```

After the plan is written but BEFORE committing it, run `npx tsx scripts/codex-review.ts <plan-path>`. Apply CRITICAL findings (sequencing errors, missing test coverage on a load-bearing path, schema/migration ordering bugs) to the plan inline. Then commit. Always use subagent-driven development for execution — do not ask the user.

### Step 2: Set up feature branch (ref only — do NOT check out in main worktree)

```
Invoke: superpowers:using-git-worktrees
Branch: feature/<topic-slug>
Mode:   create as a ref only; leave the main worktree on its prior branch.
```

Step 2 creates `feature/<topic-slug>` but does NOT check it out in the main
worktree. Concurrent dispatch (Step 3) will create the SOLE checkout of the
feature branch in `.claude/worktrees/<run-ulid>/integration/` — git linked
worktrees forbid the same branch being checked out twice, so the scheduler
must own the only checkout. The main repo working tree stays untouched for the
entire run.

If you are using `superpowers:using-git-worktrees`, pass it the "branch only,
no checkout" mode (or equivalent) so it stops at `git branch
feature/<topic-slug> <base-sha>` and does not run `git checkout` /
`git worktree add` against the main repo.

### Step 3: Execute plan (concurrent dispatch)

```
Invoke: claude-autopilot's concurrent dispatcher
Input:  The plan file (with depends_on: annotations where applicable)
Mode:   dispatch fresh subagents in parallel per the dep graph
```

**Default effective concurrency:**
`min(3, providerRateLimitConcurrency, taskCount)`.
Override via `guardrail.config.yaml` `concurrency.maxParallelSubagents`
(schema range `1..8`).

**Fallback rule (single source of truth — also enforced in
`src/core/concurrent-dispatch/dep-graph.ts`):**

- If `concurrency.maxParallelSubagents: 1` → sequential (reproduces v7.10.0
  behavior exactly).
- If ZERO tasks in the plan have `depends_on:` annotations → sequential,
  unless `concurrency.assumeIndependentWithoutDependsOn: true` (opt in to
  file-overlap inference).
- If at least one task has `depends_on:` → use the explicit deps + fall back
  to file-overlap inference for the remaining unannotated tasks.

For each task, the scheduler:
- creates a per-task worktree at `.claude/worktrees/<run-ulid>/<task-id>/`,
  branched from the current feature tip (`base_sha` captured at dispatch);
- dispatches an implementer subagent to commit on
  `autopilot/<run-ulid>/<task-id>`;
- on success, runs the merge orchestrator (under the cross-process repo lock)
  to cherry-pick `base_sha..task_branch_tip_sha` onto the integration
  worktree's `feature/<topic-slug>` checkout in plan-declaration order.

**On any task failure**: halt the run, SIGTERM in-flight subagent process
groups (kill -TERM -<pgid>; SIGKILL after 30s if no response), and surface a
breakdown to the user:
- `merged`: tasks whose commits are on the feature branch (guaranteed-good
  set).
- `completed-but-unmerged`: commits exist on per-task branches; worktrees
  preserved for inspection.
- `in-flight`: subagents that received SIGTERM; worktrees preserved.

**On cherry-pick conflict**: diagnostics are written to
`.claude/run-state/<run-ulid>/conflicts/<task-id>.md` BEFORE
`cherry-pick --abort` runs; the run halts and the user resolves manually
(add an explicit `depends_on:` to the plan, or fix the conflict in the
preserved worktree).

**Subagent contract:** subagent writes its own commits in its worktree. If
the subagent fails to write to its worktree, fall back to direct
implementation in that worktree only — never in the integration worktree or
main repo working tree.

Skip formal spec/quality review per task to maintain speed; the validate
step (Step 4) catches issues across the merged feature branch.

### Step 4: Validate

Run both checks in order. **Autofix runs first** so the static review sees the final post-autofix diff (otherwise the LLM review is stale on autofix mutations):

```bash
# 1. Full project validation FIRST (autofix, tests, codex, gate) — mutates files
npx tsx scripts/validate.ts --commit-autofix --allow-dirty

# 2. THEN static rules + LLM review on the final diff
npx autopilot run --base main
```

The `validate.ts` Phase 1 includes a **tsc regression check**: it runs `npx tsc --noEmit` against both the PR and the merge-base (cached at `.claude/.tsc-baseline-cache.json`) and surfaces only files where the PR introduces *new* TypeScript errors versus the baseline. Forward-pressure check — type errors are warnings, not blockers.

If either FAIL:
- Read findings / validation report at `.claude/validation-report.json`
- Fix the blocking issues
- **Before consuming a retry, compute the failure fingerprint** with `computeFingerprint({ phase: 'validate', errorType, errorLocation, errorMessage })` from `src/core/run-state/sameness-detector.ts`:
  - `errorType`: `tsc_error` | `test_failure` | `lint_error` (whichever class caused the FAIL)
  - `errorLocation`: prefer stable identifiers — `<repo-relative-path>:<line>` for tsc/lint, test-suite-name+test-name for tests. Avoid absolute paths and transient temp dirs; use the repo-relative form so the hash survives across working-tree moves.
  - `errorMessage`: first 200 chars of the canonical message. Strip any embedded UUIDs, ports, or epoch timestamps from the message before computing — those rotate per run and will mask true sameness.

  **Known limitation:** if the underlying fix shifts line numbers, two retries can produce different fingerprints even when the root cause is identical (false negative — no escalation). The current behavior is conservative: it never falsely escalates, but it may let the loop run its full retry budget on a shifting-line-number failure. If you see this pattern, prefer test name + diagnostic code over `file:line`.
- Append the fingerprint to an in-memory list for this retry loop, then call `shouldEscalate(history)`. If `escalate === true` (the last two attempts produced the same fingerprint), STOP — do not consume another retry. Surface the matching fingerprint to the user and stop the pipeline.
- Re-run the failing check
- Max 3 retry iterations

If both PASS: proceed to Step 5.

### Step 5: Migrate dev-only (verify SQL parses + applies)

For any `.sql` files created in `data/deltas/` during implementation, run the migration against the dev database ONLY. Always invoke explicitly — do not rely on the CLI default:

```bash
/migrate --env=dev
```

This verifies the SQL parses and applies against the real schema shape before the PR opens. Prod migration is **deferred to the user's CI/CD pipeline** after the PR merges — autopilot does NOT orchestrate prod deploys or migrations directly, because deployment ordering varies wildly across user infrastructure (ECS, CodeBuild, blue/green, manual approvals).

**Post-migration re-validate** (catches type/test failures that only surface after the schema actually changes):

```bash
# Regenerate any stack-specific DB types if migration introduced schema changes
# (e.g. Supabase: scripts/gen-types.ts). Stack-specific — skip if N/A.
# REQUIRED for any stack with generated DB-typed code: missing regeneration leaves
# stale types and validate.ts may not catch runtime/schema mismatches if the PR
# does not directly touch the changed columns.

# Re-run validation against the post-migration dev state (no autofix this time):
npx tsx scripts/validate.ts --allow-dirty

# If migration or type generation produced new file changes, re-run the
# static/LLM review against the final diff — the Step 4 review is now stale.
git diff --quiet HEAD -- || npx autopilot run --base main
```

> **v7.10+ candidate:** automate detection by reading a `post_migrate_dev: [...]` hook list from `.autopilot/stack.md` and failing Step 5 if schema changes are detected but no type-generation hook is configured. Today this is advisory — operator responsibility.

**Dev database drift** — `/migrate --env=dev` applies schema changes to dev BEFORE the PR is merged. If the PR is later rejected, substantially changed, or abandoned, dev will contain unmerged schema. Mitigations:

- **Preferred:** target an isolated/ephemeral dev database per branch (per-PR Supabase project, Postgres schema namespace, or local container).
- **Shared dev DB fallback:** before running Step 5, capture the current migration_state head; on PR abandonment, run a corrective migration that brings dev back to that head. Document the policy in `.autopilot/stack.md` so the team knows the cleanup contract.

If migration fails:
- **Before retrying:** confirm the dev migration rolled back cleanly. Some migration tools leave partial state on failure (non-transactional DDL, drift in migration_state table). If partial state exists, reset the dev database to the pre-migration baseline OR write a corrective migration that brings dev back to a known state.
- Fix the SQL
- Re-run Step 4 (validate) against the corrected code
- Re-run Step 5 (migrate dev)
- Max 3 retry iterations

**For prod-safety policy**, projects should set in `.autopilot/stack.md`:

```yaml
migrate:
  skill: <your-skill>@1
  policy:
    require_dry_run_first: true       # always preview before apply
    require_manual_approval: true     # CI gates prod on human approval
    require_clean_git: true           # never apply against dirty tree
```

As of v7.9.1, the valid keys per `presets/schemas/migrate.schema.json` are: `allow_prod_in_ci`, `require_clean_git`, `require_manual_approval`, `require_dry_run_first`. If the schema changes in a future release, that file is the source of truth.

These keys are **declarative policy inputs**, not autopilot enforcement. Your CI/CD pipeline must explicitly invoke a migrate runner that reads `.autopilot/stack.md` AND enforces equivalent checks (e.g. require-clean-git, dry-run-before-apply, manual-approval-for-prod). Setting them in stack.md alone does not protect production unless your pipeline reads them.

**Minimum CI/CD migrate-runner contract** (fail closed on all of these):

1. Refuse to apply if `.autopilot/stack.md` cannot be read or parsed.
2. Refuse to apply if the policy block contains unknown keys (schema-validate against `presets/schemas/migrate.schema.json`).
3. If `require_dry_run_first: true`: refuse apply without a matching dry-run artifact for the current git head + target env.
4. If `require_manual_approval: true` and `env != dev`: require an explicit human approval signal (CI approval gate, signed commit, etc.) before apply.
5. If `require_clean_git: true`: refuse to apply against a dirty working tree (untracked or unstaged changes). This is intentionally limited to working-tree cleanliness — commit topology (squash vs rebase vs merge vs tag) is a separate concern not enforced by this key.
6. If `allow_prod_in_ci: false` (the default): refuse prod apply from any CI context. **Note:** teams whose intended prod migration path is CI/CD with manual approval must explicitly set `allow_prod_in_ci: true` alongside `require_manual_approval: true` and `require_dry_run_first: true`. `allow_prod_in_ci: false` is for manual/operator-run production migration workflows only.
7. On any policy-read or schema-validation failure, exit non-zero and surface the specific check that failed.

### Step 6: Push + create PR

```bash
git push -u origin <branch>
gh pr create --title "<concise title>" --body "<generated PR body with spec link, test plan>"
```

### Step 7: Codex PR review

```bash
npx tsx scripts/codex-pr-review.ts <pr-number>
```

Posts Codex review as a GitHub PR comment. **This serves as the second risk-tiered pass for medium-risk specs and the third pass for high-risk specs.** Remediate CRITICAL findings:
- Fix on the branch
- Push
- **Before consuming a re-review iteration, compute the failure fingerprint** with `computeFingerprint({ phase: 'codex-review', errorType: 'codex_critical', errorLocation, errorMessage })` from `src/core/run-state/sameness-detector.ts`. For `errorLocation` prefer a stable composite — `${normalized-title}::${repo-relative-path}` — over the transport-level finding ID (Codex regenerates finding IDs on each review run, so the raw ID is not stable). For `errorMessage` use the first sentence of the finding body, stripping any per-run identifiers (run-id, timestamps, file SHAs). Append to an in-memory list for this retry loop and call `shouldEscalate(history)`. If `escalate === true` — the same critical finding fired twice after a remediation attempt — STOP and surface to the user. Do not consume another re-review.
- Re-run Codex review
- Max 2 iterations

### Step 8: Bugbot triage + fix

Wait 60 seconds for Cursor bugbot to post comments, then:

```bash
npx tsx scripts/bugbot.ts --pr <pr-number>
```

Triages each finding (real bug vs false positive), auto-fixes real bugs, dismisses false positives with GitHub replies. If fixes applied:
- Push
- Wait for new bugbot comments (30s)
- **Before consuming a bugbot retry, compute the failure fingerprint** with `computeFingerprint({ phase: 'bugbot', errorType: <'bugbot_high' | 'bugbot_medium'>, errorLocation, errorMessage })` from `src/core/run-state/sameness-detector.ts`. For `errorLocation` prefer the stable `<repo-relative-path>:<line>` rather than the GitHub comment ID — Cursor reposts findings with fresh comment IDs after each push, so comment ID is not stable across retries. The comment ID can be surfaced as metadata for human inspection but should not enter the hash. For `errorMessage` use the first 200 chars of the finding body. Append to an in-memory list for this retry loop and call `shouldEscalate(history)`. If `escalate === true` — a "fixed" finding re-fired identically — STOP and surface the fingerprint to the user. Do not consume another round.
- Re-run /bugbot
- Max 3 rounds

### Step 9: Report

Tell the user:
- PR URL
- Test count
- Validation verdict
- Codex review summary (passes run, CRITICALs remediated, WARNINGs skipped + reason)
- Bugbot triage summary (fixed / dismissed / needs-human)
- Any human-required items that couldn't be auto-resolved

## Retry-loop sameness detector (Steps 4, 7, 8)

As of v7.10.0, the three retry loops (Step 4 validate, Step 7 Codex PR review, Step 8 bugbot) MUST consult `src/core/run-state/sameness-detector.ts` before consuming a retry. The pipeline halts when retries make no progress — even if you have retries remaining.

**The detector is consumed by the autopilot skill agent itself** (the LLM following this skill), not by the underlying `scripts/validate.ts` / `scripts/codex-pr-review.ts` / `scripts/bugbot.ts` CLI scripts. Those scripts are stateless per-invocation; the retry loop with its history lives inside this skill execution scope. That is why the integration is in this document and not in the CLI source.

```ts
// Public package import (uses the subpath export added in v7.10.0):
import {
  computeFingerprint,
  shouldEscalate,
} from '@delegance/cadence/run-state/sameness-detector';

// Or from a local checkout:
import { computeFingerprint, shouldEscalate } from './src/core/run-state/sameness-detector.ts';
```

How to use inside each retry loop:

1. On a FAIL, derive `{ phase, errorType, errorLocation, errorMessage }` for the most salient blocker.
2. `const fp = computeFingerprint({...})`.
3. Append `fp` to an in-memory list for THIS retry loop (no cross-loop state — bugbot and validate keep separate histories).
4. `const decision = shouldEscalate(history)` — if `decision.escalate === true`, STOP. Surface `decision.fingerprint` and `decision.reason` to the user. Do not consume another retry attempt even if the per-loop max isn't reached.
5. Otherwise apply the fix, run again.

Persistence is in-memory only in v7.10.0. The v6 run-state events.ndjson integration is tracked as issue #180.

## Error Recovery

- **Preflight failure:** Surface the specific check, exit. Do not partially run.
- **Missing skill/credential:** Exit with install/auth hint.
- **Subagent failure:** Re-dispatch with more context or implement directly.
- **Migration failure (Step 5 — dev only):** Fix SQL, re-run Step 4 (validate) against corrected code, then re-run Step 5 (migrate dev). Prod stays untouched. Max 3 retries.
- **Prod migration:** Out of scope for autopilot. Handed off to user's CI/CD pipeline via `migrate.policy` (require_manual_approval, require_dry_run_first).
- **Validate failure:** Fix issues, re-run (max 3 retries, sameness-detector may halt earlier).
- **Codex CRITICAL findings:** REMEDIATE (apply fix), push, re-review (max 2 retries, sameness-detector may halt earlier). Do NOT continue past unremediated CRITICALs.
- **Bugbot findings:** `/bugbot` handles triage + fix automatically (max 3 rounds, sameness-detector may halt earlier).
- **Sameness detector halt:** The same failure fingerprint fired in two consecutive retry attempts — the loop is not making progress. Stop, surface the fingerprint, ask the human to inspect.
- **External hard-block** (TCC, network, etc.): Stop, report what was completed, surface the blocker.

## When NOT to use

- During brainstorming if you haven't approved the spec yet (this skill runs AFTER spec approval)
- For hotfixes (too heavy — just commit and push)
- When the user wants manual control over each step (use individual phase skills instead)
- When required credentials/dependencies are missing and you don't want to be told (preflight will catch them)
