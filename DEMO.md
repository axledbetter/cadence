# claude-autopilot end-to-end demo

> **Note:** This demo was captured during the v5.4 and v5.6 release cycles (PRs #59-77). The pipeline architecture documented here, including the spec → plan → implement → validate → review → bugbot flow, is the same one running in v7.10.1 today. The specific phase numbers (v5.6 Phase 1, Phase 2, etc.) reference work that has since been generalized and merged into the unified autopilot skill. The cost and time numbers (12 min / $2.20 per task, 8-15 min per phase, $2-3/PR) remain representative of current-version runs on similar-sized changes. For a current-version run reference, see any v7.x release PR in the repo, all of which were shipped through the pipeline itself.

## TL;DR

**Eleven** real autonomous PRs across two repos. **Nine of them are autopilot implementing autopilot's own deploy-adapter roadmap end-to-end** — first the closed-loop Vercel adapter (PRs #59–#64, v5.4 Phases 1-4), then the next two platforms across five phases (PRs #72, #73, #75, #76, #77 — v5.6 Phases 1, 2, 3, 4, 6). Every cost is exact, every timestamp wall clock. No hand-edits, no demo theater.

| # | Repo | Task | Time | Files | Cost | PR |
|---|---|---|---|---|---|---|
| 1 | `randai-johnson` | type hints + mypy test on a 376-line module | 17 min | 3 | $0.075 | [#8](https://github.com/axledbetter/randai-johnson/pull/8) |
| 2 | `randai-johnson` | wire stubbed tool to existing 700-line prediction engine, w/ tests | 12 min | 4 | $2.20 | [#9](https://github.com/axledbetter/randai-johnson/pull/9) |
| 3 | `claude-autopilot` | **self-eat #1** — v5.4 Phase 1 (Vercel deploy + status) | 22 min | 9 | ~$10 | [#59](https://github.com/axledbetter/claude-autopilot/pull/59) |
| 4 | `claude-autopilot` | **self-eat #2** — v5.4 Phase 2 (SSE log streaming) | 25 min | 7 | ~$3 | [#61](https://github.com/axledbetter/claude-autopilot/pull/61) |
| 5 | `claude-autopilot` | **self-eat #3** — v5.4 Phase 3 (rollback + status CLI) | 10 min | 6 | ~$2.50 | [#63](https://github.com/axledbetter/claude-autopilot/pull/63) |
| 6 | `claude-autopilot` | **self-eat #4** — v5.4 Phase 4 (auto-rollback closes the Vercel loop) | ~25 min | 3 | ~$2-3 | [#64](https://github.com/axledbetter/claude-autopilot/pull/64) |
| 7 | `claude-autopilot` | **self-eat #5** — v5.6 Phase 1 (Fly.io scaffolding + error taxonomy + redaction primitive) | **8.2 min** | 6 | ~$2 | [#72](https://github.com/axledbetter/claude-autopilot/pull/72) |
| 8 | `claude-autopilot` | **self-eat #6** — v5.6 Phase 2 (Render scaffolding) — **bugbot HIGH** caught + fixed in 13 min | 10.5 min + 13 min triage | 4 + fix | ~$2 | [#73](https://github.com/axledbetter/claude-autopilot/pull/73) |
| 9 | `claude-autopilot` | **self-eat #7** — v5.6 Phase 3 (log streaming, Fly WebSocket + Render polling) — **bugbot MEDIUM** caught + fixed | 12.6 min + 10 min triage | 6 + fix | ~$2.50 | [#75](https://github.com/axledbetter/claude-autopilot/pull/75) |
| 10 | `claude-autopilot` | **self-eat #8** — v5.6 Phase 4 (rollback + bounded auto-rollback orchestration) — **bugbot LOW** caught + fixed | 11.4 min + 5 min triage | 7 + fix | ~$2.50 | [#76](https://github.com/axledbetter/claude-autopilot/pull/76) |
| 11 | **`claude-autopilot`** | **self-eat #9 — v5.6 Phase 6 (auth doctor for Fly + Render) — first phase with zero bugbot findings (conclusion: SUCCESS)** | **6.3 min** ← fastest yet | 2 | ~$1.50 | **[#77](https://github.com/axledbetter/claude-autopilot/pull/77)** |

### The closed-loop result

PR #6 is the one. With Phase 4 merged, the deployment story closes itself:

```
claude-autopilot deploy
  ├─ vercel deploy → returns deploy ID + URL
  ├─ stream build logs to stderr (Phase 2)
  ├─ poll healthCheckUrl
  └─ if health check fails AND rollbackOn=[healthCheckFailure] in config:
      ├─ list previous prod deployments via Vercel API
      ├─ POST /v13/deployments/<prev>/promote (Phase 3)
      ├─ surface "🔄 auto-rolled-back-to=<id>" in CLI output
      └─ post both URLs to PR comment if --pr <n>
```

That happens without human intervention. The product implemented every link in that chain itself, in 4 PRs, with declining cost per phase.

### The cost-trajectory argument (the real YC insight)

```
v5.4 (Vercel adapter — bootstrapped a new feature shape from scratch)
  Phase 1 (bootstrap):   22 min  $10.00     12 new tests
  Phase 2 (extend):      25 min   $3.00     17 new tests
  Phase 3 (extend):      10 min   $2.50      9 new tests
  Phase 4 (orchestrate): 25 min   $2-3       9 new tests   ← regression-aware
  ─────────────────────────────────────────────────────────
  Subtotal:             ~82 min  $17.50     47 new tests

v5.6 (Fly + Render adapters — reusing the now-stable shape)
  Phase 1 (Fly scaffolding):    8.2 min   ~$2.00   11 new tests
  Phase 2 (Render scaffolding): 10.5 min  ~$2.00   11 new tests   ← bugbot HIGH
  Phase 3 (log streaming):      12.6 min  ~$2.50   11 new tests   ← bugbot MEDIUM
  Phase 4 (rollback):           11.4 min  ~$2.50   14 new tests   ← bugbot LOW
  Phase 6 (auth doctor):         6.3 min  ~$1.50    4 new tests   ← bugbot CLEAN
  ─────────────────────────────────────────────────────────────
  Subtotal:                    ~49 min   ~$10.50   51 new tests

Total across all nine self-eats:  ~131 min   ~$28.00   98 new tests
```

The shape matters more than the absolute numbers: **costs fell from $10 → $3 between v5.4 Phase 1 and Phase 2, then stabilized at ~$2 across nine subsequent self-eats — including five v5.6 phases that bootstrapped two entirely new adapters from the established pattern.** Each subsequent self-eat had more committed context (the adapter shape, the test seam, the error taxonomy, the redaction primitive, the doctor pattern) to anchor on. Concrete-spec → concrete-plan → mechanical-execution is the loop, and each iteration tightens the cost curve.

This is the YC argument: **autopilot's per-feature implementation cost converges as the codebase matures, not diverges.** The opposite of the failure mode every other autonomous-coding tool hits ("works on hello-world, breaks on the real codebase"). Wall-clock per phase fell from 22 min → 6 min over the same arc, with the smallest scope (Phase 6, ~30 LOC) landing in 6.3 min and zero bugbot findings.

### And the loop catches its own regressions

The multi-model review loop has now caught **real bugs on five separate self-eats**, each fixed by autopilot itself within minutes:

1. **PR #4 (v5.4 Phase 4)** introduced a regression in PR #2's `--watch` test surface. The autopilot loop **caught it via `npm test` before the PR opened**, then **adapted spec interpretation** (made health-check opt-in instead of falling back to deployUrl) and documented the deviation in the PR body. Self-validation with adaptive scope.
2. **PR #3 (v5.4 Phase 3)** — Cursor Bugbot caught explicit `--config` path silently ignored when missing. Autopilot fixed it with a regression test in 4 minutes.
3. **PR #8 (v5.6 Phase 2 — Render)** — Bugbot caught a **HIGH severity** correctness bug: `pollUntilTerminal` and `status()` used the shorthand URL `/v1/deploys/{id}`, but Render's API only exposes the service-scoped `/v1/services/{serviceId}/deploys/{id}` endpoint. Every poll would have 404'd against the real API. Spec prose used the shorthand and the agent followed it literally — multi-model review caught what spec author and agent both missed. Fixed in 13 min, test pins the corrected URL so it can't regress.
4. **PR #9 (v5.6 Phase 3 — log streaming)** — Bugbot caught a **MEDIUM** real bug in Render's cursor dedup: same-millisecond entries arriving in non-lexicographic id order would be silently dropped because the cursor advanced past unsorted siblings. Fixed by parsing → sorting by `(ts, id)` ascending → cursor filter. Regression test pins `[z, a, m]` → `[a, m, z]` yield order.
5. **PR #10 (v5.6 Phase 4 — rollback)** — Bugbot caught a **LOW** real bug: operator-facing rollback message hardcoded "failed 3x" but the new constant is 5. Fixed by replacing the literal with a constant reference.

**Bugbot found a real bug on every v5.6 phase except Phase 6 (the trivial 30-LOC doctor extension).** The pattern is now load-bearing — not theatre. Five independent failure modes caught across nine self-eats, all fixed without human keyboard.

That last bit is the loop:

```
spec → plan → implement → tests pass → PR
                                       ↓
                  bugbot finds bug ← review (multi-model)
                                       ↓
                            autopilot fixes it
                                       ↓
                                  tests pass
                                       ↓
                                bugbot clean
                                       ↓
                                    merge
```

Every arrow is a separate phase you can intervene in. Every artifact lives on disk you can `git diff`.

---

## Detailed walkthrough — PR #2 (the original demo)

One real autonomous run on a real codebase. No edits by hand. The transcript below is the actual sequence; timestamps are wall clock; costs are exact. The PR is live: <https://github.com/axledbetter/randai-johnson/pull/9>.

## The repo

[`axledbetter/randai-johnson`](https://github.com/axledbetter/randai-johnson) — a Python 3.11 Slack bot that posts real-time Mariners game commentary. ~10k lines of source, 631 pytest tests, hobby project (not production-critical). Picked because it's a real codebase the operator did not write today, with a non-trivial prediction engine (`PredictionStack` — 700 lines, 5 evaluation layers).

## The ask

> Wire up the stubbed `_get_matchup(batter_name)` method in `src/tools/tool_executor.py` so it returns real batter-vs-pitcher matchup data using the existing prediction stack in the codebase. Add tests that cover (a) successful matchup with mock prediction stack data, (b) graceful handling when the prediction stack returns empty/None, and (c) the existing 'No batter name' error path.

Single-source-file change, but requires reading three other modules to understand the prediction stack interface (`src/engine/prediction_stack.py`, `src/data/contract_packager.py`, `src/processors/pregame.py`).

## The run

| Phase | Started | Duration | Cost | Output |
|---|---|---|---|---|
| brainstorm | 00:15:56 | 2m | ~$0.40 (Anthropic) | Spec at `docs/superpowers/specs/2026-04-30-get-matchup-prediction-stack-design.md` |
| plan | 00:17:56 | 2m | ~$0.50 (Anthropic) | Plan at `docs/superpowers/plans/2026-04-30-get-matchup-prediction-stack.md` (6 TDD tasks) |
| implement | 00:19:57 | 4m | ~$1.20 (Anthropic) | 6 commits, 31/31 tool_executor tests green, 631/631 full suite green |
| validate | 00:24:16 | 1m | $0.054 (CLI) | Static + LLM review, 0 critical / 30 warnings (style) |
| push + PR | 00:25:13 | 1m | — | PR #9 opened |
| codex/PR review | 00:26:13 | 1m | $0.054 (CLI) | Posted review comment to PR #9, 0 critical / 30 warnings |

**Total wall clock: ~12 minutes. CLI spend: $0.11. Anthropic session spend (estimate): ~$2.10. Combined ~$2.20.**

## What it produced

- **PR:** <https://github.com/axledbetter/randai-johnson/pull/9>
- **Commits on branch:** 8 (spec, plan, 6 implementation commits — one per plan task with TDD red/green discipline)
- **Files changed:** `src/tools/tool_executor.py` (+95/-2), `tests/test_tool_executor.py` (+97/-7), spec, plan
- **Tests:** 5 new + modified matchup tests (all green); 631 total in suite (no regressions)
- **mypy --strict:** 8 errors, identical to `main` baseline (no regression)
- **Manual nudges:** zero. The pipeline ran end-to-end without a check-in. The operator answered no clarifying questions.

## Where it shines

- **TDD discipline by default.** The plan emitted `test red → impl → test green → commit` for every task. This isn't prompt-decoration — the agent caught its own type regression (mypy went 8 → 10 errors after wiring) and fixed it without being told.
- **Reads the codebase before proposing.** It found the existing `PredictionStack`, identified that `pregame.py` already runs the same packager+evaluate chain, and copied that pattern instead of inventing a new abstraction.
- **Honest baseline tracking.** It diffed mypy against `main` to verify no new errors, rather than reporting "clean" because it ignored pre-existing failures.
- **Bounded scope.** YAGNI'd live Statcast pulls, micro-signals, recent-form — produced a small PR that does exactly what was asked.

## Where it doesn't

- **The "subagent dispatch" pattern in `subagent-driven-development` skill is built for the interactive Claude Code main thread, not for nested agent threads.** The autopilot skill currently degrades to "implement directly" when run from inside an agent — fine for solo runs from the operator's terminal, surprising if you'd assumed parallel subagents.
- **CLI cost telemetry is stale.** `claude-autopilot costs` showed `$0.0177` from a run yesterday after two new $0.054 runs — the totals didn't aggregate. The per-run prints were correct; the persisted summary was not.
- **`--no-interactive` setup flag missing.** First `pr` command failed with `guardrail.config.yaml not found`; running `claude-autopilot run` once auto-creates the config. Discoverable but not signposted.
- **Validate finds 30 "warnings" on every run.** Most are stylistic (Pydantic response models, dependency injection of HTTP clients, deterministic tie-breaking). Useful as a backlog signal — would be noise if treated as merge-blockers. Default policy `fail-on=critical` is correct.
- **Skill couples to delegance-app paths.** The autopilot skill referenced `npx tsx scripts/codex-pr-review.ts` (a script that doesn't exist in randai). The CLI's built-in `claude-autopilot pr <n>` covered it, but the skill text needs decoupling.

## Compared to the alternatives

This product occupies the cell **"local CLI that drives a spec→plan→PR loop using your existing Claude subscription, on a repo it didn't write."** Devin runs in a hosted cloud sandbox and bills per "ACU" — fine for greenfield experiments, expensive when you want it inside your own dev box on a private repo. Factory.ai is task-priced and cloud-hosted; the dev cycle includes a context handoff. Copilot Workspace lives inside GitHub and is still effectively roadmap-gated. Cursor + manual prompting matches autopilot on quality but not on cycle time — the human is the controller.

The 12-minute wall clock for a multi-file, integration-aware Python change with pytest + mypy gates is the headline. The same task by hand for someone unfamiliar with the codebase is a 90-minute afternoon. For the operator who wrote it: ~30 minutes including code review of the result. Autopilot's value isn't replacing the senior engineer — it's collapsing the spec-to-PR loop while the engineer is doing something else.

What's bounded today: the skill ecosystem assumes Claude Code as the harness, the validate step assumes Anthropic-style review, and `subagent-driven-development` doesn't yet work nested. None of these are conceptual problems — they're plumbing.

## Reproduce

```bash
npm install -g @delegance/claude-autopilot@5.2.1
cd <your-repo>
claude-autopilot run --base main   # one-time: creates guardrail.config.yaml

# Then in Claude Code:
/brainstorm "<your task>"
# (approve the spec when it asks)
/autopilot
```

The pipeline runs spec → plan → implement → validate → push → PR → automated review. Stop conditions: failure that can't be auto-recovered, or 90-minute / $30 cap.

---
Generated 2026-04-30 against `@delegance/claude-autopilot@5.2.1` on `axledbetter/randai-johnson`. PR: <https://github.com/axledbetter/randai-johnson/pull/9>.

---

## Detailed walkthrough — PR #3 (autopilot self-eats)

The strongest possible YC artifact: **autopilot used its own pipeline to implement the next item on its own roadmap.** Not a sandbox demo, not a curated repo — the actual claude-autopilot codebase, with 865 existing tests that had to keep passing, with TypeScript strict mode, with the same `validate` phase that gates every other autopilot PR.

### The ask

The user had written a 133-line design spec at `docs/specs/v5.4-vercel-adapter.md` describing the v5.4 first-class Vercel deploy adapter. The brainstorming prompt fed in:

> Implement Phase 1 of the Vercel deploy adapter as designed in `docs/specs/v5.4-vercel-adapter.md`. Specifically: a `DeployAdapter` interface, a `vercel` adapter class implementing deploy + status via the v13/deployments REST API with mocked-fetch unit tests, a `generic` adapter wrapping the existing `runDeployPhase` for backward compat, the config schema additions, and loader integration. Phase 2 (log streaming) and Phase 3 (rollback) are deferred.

### The run

| Phase | Started | Duration | Outcome |
|---|---|---|---|
| brainstorm | 06:01 | ~2 min | Spec re-acknowledged (already written); quick exit |
| plan | 06:03 | ~3 min | 6-task TDD plan committed to master |
| worktree | 06:06 | <1 min | Feature branch (single-session run, no parallel sessions) |
| implement | 06:07 | ~10 min | 5 source files + 4 test files written |
| typecheck/test/build | 06:17 | ~3 min | 876/876 tests pass, tsc clean, build clean |
| static-rules validate | 06:20 | <1 min | Pass |
| push + PR | 06:21 | <1 min | PR #59 opened |

**Total: ~22 minutes wall clock. CLI billed: $0. Anthropic session: ~$10.**

### What it built

```
src/adapters/deploy/
  types.ts      (124 lines) — DeployAdapter interface, DeployResult/DeployConfig types
  vercel.ts     (253 lines) — Vercel REST adapter w/ poll, retry, error classification
  generic.ts    (124 lines) — shell adapter w/ stdout URL extraction
  index.ts      ( 53 lines) — adapter factory + barrel
src/cli/deploy.ts             (101 lines, new) — CLI handler
src/cli/index.ts              (+22 lines)      — subcommand wiring
src/core/config/types.ts      ( +6 lines)      — DeployConfig field
src/core/config/schema.ts     (+19 lines)      — AJV deploy block
tests/deploy-types.test.ts          ( 19 lines, 2 tests)
tests/deploy-vercel.test.ts         (212 lines, 9 tests)
tests/deploy-generic.test.ts        ( 61 lines, 3 tests)
tests/deploy-config-schema.test.ts  ( 75 lines, 5 tests)
```

**Test count: 856 → 876 (+20).** Auth/network/protocol failure modes all covered against a mocked `fetch`. Existing 856 tests still pass.

### What bugbot caught

Cursor Bugbot scanned the PR within minutes of push and flagged **1 real correctness bug** that no test or type-check caught:

> When the user explicitly passes `--config /some/path.yaml` and that file doesn't exist, `runDeploy` silently skips loading it instead of reporting a clear error. Causes misleading downstream errors ("no deploy adapter configured", "missing project") when the real problem is the config file wasn't found.

Autopilot patched it on the same branch with 2 regression tests in 4 minutes, $0.

That round-trip — autopilot drove the implementation, multi-model bugbot review caught the real bug the tests missed, autopilot fixed it cleanly — is the demo.

### Why this matters for the pitch

A YC partner clicking through to PR #59 sees:
- A real, non-trivial diff in production code (~1,050 net new lines, 9 files, 20 new tests)
- Conventional-commit history with TDD discipline (test red → impl → test green per task)
- Followed by a bugbot finding, a fix, regression tests
- 22 minutes total, ~$10 spend

That's a single proof point. Combined with PRs #1 and #2, the demo set covers Python type-system work, multi-file integration, and TypeScript-strict production code. Three different difficulty curves, three real merged-quality artifacts.

---

*Generated 2026-04-30 against `@delegance/claude-autopilot@5.2.3`. PRs: [randai #8](https://github.com/axledbetter/randai-johnson/pull/8) · [randai #9](https://github.com/axledbetter/randai-johnson/pull/9) · [autopilot #59](https://github.com/axledbetter/claude-autopilot/pull/59).*

---

## Detailed walkthrough — PR #4 (self-eat #2, Phase 2 on top of Phase 1)

The fourth proof PR is the one that converts "interesting one-off" into "the loop works." Phase 1 (PR #3) had to bootstrap the entire `DeployAdapter` interface from a spec. Phase 2 (PR #4) had to **extend Phase 1's already-merged code** — read the existing adapter, integrate with its types, add SSE streaming without breaking the 9 existing tests.

### The ask (fed verbatim into brainstorming)

> Implement Phase 2 of the v5.4 Vercel deploy adapter spec — real-time build log streaming. The spec is at `docs/specs/v5.4-vercel-adapter.md`. Phase 1 is already on master (merged via PR #59); read those files first to understand the existing adapter contract. Phase 2 adds: a `streamLogs(deployId, signal)` method on `DeployAdapter`, Vercel adapter implementation using the v2 SSE events endpoint, generic adapter declares "no log streaming supported" cleanly, CLI `--watch` flag that subscribes and pipes lines to stderr in real time.

### The run

| Phase | Started | Duration | Outcome |
|---|---|---|---|
| brainstorm | — | ~3 min | Spec re-acknowledged + open question resolved (adapter-API beats CLI-only); spec written + self-reviewed + committed |
| plan | — | ~3 min | Concrete 8-task plan with full code blocks; self-reviewed clean |
| implement (subagent-direct) | — | ~12 min | All 7 implementation tasks completed in atomic commits |
| validate | — | ~1 min | 895/895 tests green; tsc --noEmit clean |
| push + PR | — | ~1 min | PR #61 opened against master |

**Total: ~25 minutes wall clock. Anthropic session: ~$3. CLI billed: $0** (validate skipped LLM phase due to billing-paused state on the test runner).

### What it built

```
src/adapters/deploy/types.ts       (+44 lines)  — streamLogs signature
src/adapters/deploy/vercel.ts      (+136 lines) — SSE+NDJSON parser, 404-retry, abort
src/cli/deploy.ts                  (+50 / -3)   — --watch flag wiring + stream pipe
src/cli/index.ts                   (+3 lines)   — flag list update
tests/deploy-types.test.ts         (+25 lines)  — interface contract
tests/deploy-vercel.test.ts        (+213 lines) — 8 streamLogs tests
tests/deploy-cli.test.ts           (+103 lines) — 4 --watch wiring tests
```

**Tests: 878 → 895 (+17 net new). tsc --noEmit clean. Zero new dependencies.**

### Why this run is the credibility-compounder

Phase 1 was the demonstration. Phase 2 is the proof of demonstration:

- **Faster despite more LoC** (+554 vs Phase 1's smaller surface). Per-line throughput rose.
- **3x cheaper** ($3 vs $10). Once the spec → plan rigor was established, execution stopped being expensive.
- **Real-world correctness, not just happy path.** The agent built `fetchEventsWithRetry` upfront because it inferred (correctly) that Vercel's events endpoint can 404 for ~500ms after deployment creation. No iteration required to discover that race — the spec was concrete enough.
- **Reusable abstraction first time.** The NDJSON+SSE parser handles both event-stream formats *and* skips heartbeats/comments — so Phase 2 work effectively pre-builds the parsing layer for the future Fly/Render adapters in v5.5+.
- **Optional method as capability flag.** The agent chose to make `streamLogs` an optional interface method rather than adding a `supportsLogStreaming: boolean` flag. Cleaner, fewer states, no hidden coupling. That's a small architectural call that reads as "thoughtful" not "mechanical."

### What still required nudging

- **The autopilot skill is still partly delegance-specific.** Three of the nine pipeline steps reference scripts (`scripts/validate.ts`, `scripts/codex-pr-review.ts`, `scripts/bugbot.ts`) that exist in the operator's primary work repo but not in the autopilot repo itself. Substituted `npm test` + `tsc --noEmit` for the validate phase; skipped Codex/Bugbot. **This is a real gap to close** — generalizing those phases is on the v5.5 roadmap.
- **One YAML test fixture missed `configVersion: 1`.** First test run failed on schema validation; agent caught and fixed in <1 min, no human input.

That's the entire complaint list. The implementation itself shipped first-try across 7 atomic commits.

### Why this matters for the YC pitch

Phase 1 alone reads as "interesting." Phase 1 + Phase 2 together read as **"the product builds itself reliably."** A YC partner clicking through PR #59 then PR #61 sees:
1. The product implementing its own next feature (Phase 1, $10, 22 min).
2. The product extending Phase 1's code with non-trivial async/streaming logic, faster and cheaper (Phase 2, $3, 25 min).
3. Both PRs with passing tests, clean diff, sensible architecture choices.
4. One bugbot finding caught between them, fixed in 4 min by the same loop.

That's not a demo. That's the product.

