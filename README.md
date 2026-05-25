# @delegance/claude-autopilot

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![GitHub](https://img.shields.io/badge/GitHub-axledbetter%2Fclaude--autopilot-181717?logo=github)](https://github.com/axledbetter/claude-autopilot) [![npm](https://img.shields.io/npm/v/@delegance/claude-autopilot.svg)](https://www.npmjs.com/package/@delegance/claude-autopilot)

**Autonomous development pipeline for Claude Code. Brainstorm → spec → plan → implement → migrate → validate → PR → review → merge — all from your terminal, on your codebase, with your test suite.**

**Open source, MIT-licensed, runs on your machine with your API keys.** No hosted agent, no per-seat subscription — `npm install -g @delegance/claude-autopilot@latest` and you're done.

## Hosted dashboard (early access)

A hosted dashboard for team-wide run history, cost roll-up, and member management is in design-partner phase — not yet open for self-serve signup. The CLI is and stays fully usable without it.

If you're interested in early access, open an issue or email alex@delegance.com. Otherwise the rest of this README covers everything you need to run the CLI locally with your own API keys.

```bash
claude-autopilot brainstorm "add SSO with SAML for enterprise tenants"
# → writes spec (reviewed by Codex) → writes plan (reviewed by Codex) →
# → creates branch → implements with subagents → runs migrations →
# → runs full test + lint + type + security gate → opens PR →
# → runs risk-tiered Codex PR review (1/2/3 passes by spec risk) →
# → triages bugbot findings, auto-fixes real bugs, re-runs validate →
# → merges with your configured permissions (default is admin-squash;
#   configure branch protection + required checks if you need to enforce
#   reviews/CI gates that the autopilot agent should not bypass)
```

*No hosted agent. No per-seat subscription. Runs locally on your machine, against your real repo, using your API keys. Every phase is a Claude Code skill you can intervene in, rewire, or run by itself.*

**See it work end-to-end:** [DEMO.md](DEMO.md) — one real autonomous run on a Python codebase. 12 minutes wall clock, $2.20 spend, 5 new tests, multi-file integration, zero manual intervention. Honest about what's bounded today.

---

## Benchmark

On a Next.js fixture seeded with 13 production-realistic bugs covering the categories the README advertises — SQL injection, hardcoded secret, missing auth, IDOR, CORS wildcard, SSRF, open redirect, TOCTOU race, silent error swallow, off-by-one, missing rate limit, console.log in prod, and missing input validation:

| Configuration | Bugs caught | Cost | Time |
|---|---|---|---|
| **`claude-autopilot scan --all` with Claude Opus** | **13 / 13** | $0.21 | 38 s |

Every finding came with a concrete remediation (often a code patch or named library — `Zod` for validation, atomic Postgres updates for TOCTOU, allowlist + DNS resolution for SSRF). [Reproduce the benchmark.](#reproducing-the-benchmark)

---

## Why this vs the alternatives

| Tool | Where code lives | Pricing model | Models | Pipeline | Intervenable? |
|---|---|---|---|---|---|
| **Devin** (Cognition) | Hosted sandbox | Per-ACU (cloud markup) | Cognition's stack | Opaque | No — dashboard only |
| **Factory Droids** | Hosted | Per-task + seat | Factory's stack | Fixed | Limited |
| **GitHub Copilot Workspace** | GitHub-hosted | Per-seat ($) | Copilot only | Fixed, non-extensible | Edit the plan |
| **Cursor / Copilot agent mode** | Local IDE | Per-seat ($) | Vendor's model | None — single-shot | Continuous |
| **Cursor BugBot / CodeRabbit** | Hosted | Per-PR or seat | Vendor's model | Review only | Post-hoc |
| **Aider / Cline** | Local CLI | Free + your API key | User's choice | None | Continuous |
| **OpenHands / SWE-agent** | Local research | Free | User's choice | Agent decides | Rare |
| **claude-autopilot** | **Local CLI, your repo** | **Open source CLI + your model/API costs (Claude / Codex / Gemini / Groq / Ollama-local)** | **Multi-model per role (Claude + Codex + Gemini)** | **Skill-per-phase, rewireable** | **Every phase, all state on disk** |

Four things only this product gives you:

1. **No hosted workspace or remote sandbox.** Your repo stays on your machine. No third-party agent runtime, no SaaS-side orchestration, no per-seat markup. Model prompts (diffs, file context, design questions) are sent to whichever LLM providers you've configured (Anthropic / OpenAI / Google / Groq / Ollama-local). For a truly local-only setup, you must point _every_ model used by the entire execution path at a local endpoint: that includes the Claude Code agent runtime itself (configure a local Claude Code provider) AND the autopilot review adapter (`openai-compatible` pointed at Ollama). Pointing only the review adapter at Ollama still ships prompts/diffs to Anthropic via Claude Code. For most teams, local-only isn't the goal; "no hosted orchestration + your existing provider keys" is.
2. **Risk-tiered review depth (policy-driven).** Specs declare `risk: low | medium | high` in frontmatter. The autopilot skill runs 1 / 2 / 3 sequential Codex passes accordingly, each with a remediation cycle in between. Enforcement is encoded in the skill (an LLM-driven instruction set, not a hard CLI gate) so it's auditable and editable: read `.claude/skills/autopilot/SKILL.md`, swap the tier rules for your codebase, expand the auto-escalation keyword list. Designed for teams that want review depth to scale with change risk instead of running forensic-grade review on every typo.
3. **Ships as a Claude Code skill, not a competing IDE.** `/brainstorm`, `/autopilot`, `/migrate`, `/validate` are first-class Claude Code commands. As Claude Code grows, autopilot rides that adoption. You don't switch tools to use it; it's already there.
4. **Multi-model council, available as a verb.** `claude-autopilot council` dispatches the same diff or design question to Claude + Codex + Gemini in parallel and synthesizes the consensus. Wire it into the autopilot pipeline by editing `.claude/skills/autopilot/SKILL.md` Step 7, or invoke standalone for one-off design decisions. The default pipeline uses sequential Codex review (cheaper, faster, often sufficient for routine changes); council is the higher-rigor option when you want broader model diversity.

Plus the four practical differences:

- **Multi-model by role.** Claude writes code, Codex reviews the plan, bugbot triages PR findings. Swap any of them.
- **Your stack, not a sandbox.** Runs your `npm test`, your `prisma migrate`, your `gh pr create`. If it works in your terminal, it works in the pipeline.
- **Phase artifacts on disk, editable.** Every phase writes to a file you can open — `docs/specs/*.md`, `docs/plans/*.md`, a branch, a PR. Stop, edit by hand, resume, or re-run any phase in isolation.
- **Test-gated auto-revert.** `claude-autopilot fix --verify` patches a file, runs your tests, reverts on failure. Built into the CLI, not a wrapper.

**Real numbers from a real run:** [DEMO.md](DEMO.md) — autonomous multi-file change on a Python codebase, **12 minutes, $2.20, zero manual intervention.**

## 30-second quickstart

```bash
# Install
npm install -g @delegance/claude-autopilot

# One-shot setup — detects stack, writes config, installs skills, sets hooks
claude-autopilot init

# Ship a feature end-to-end
claude-autopilot brainstorm "add rate limiting to the public API"
# Answer ~5 questions. Spec written. Codex reviews it. You approve.
# Claude walks the plan → implementation → migration → tests → PR → review.
# ~15-40 min for a typical feature.

# Or run just the review layer on an existing PR
claude-autopilot run --pr 123
```

## Run State Engine (v6)

Persistent state for autopilot runs. Resume after crashes, enforce hard budget caps, and surface typed JSON events for CI consumers — all opt-in, all on disk.

```yaml
# guardrail.config.yaml
engine:
  enabled: true              # default in v6.1+; explicit `false` is deprecated and removed in v7
budgets:
  perRunUSD: 10              # hard stop; mandatory runtime guard
  perPhaseUSD: 5
```

```bash
claude-autopilot scan --all                  # any command — engine writes a per-run dir
claude-autopilot runs list                   # newest-first, with status / cost / lastPhase
claude-autopilot runs show 01HZK7P3D8Q9V…    # state snapshot + optional event tail
claude-autopilot run resume 01HZK7P3D8Q9V…   # lookup-only today; live execution in a later v6.x
claude-autopilot runs gc --older-than-days 7 # retire completed runs
```

Every state transition appends a typed event to `.guardrail-cache/runs/<ulid>/events.ndjson`; every CLI verb supports `--json` with strict stdout-envelope / stderr-NDJSON channel discipline. Side-effect phase replay consults persisted `externalRefs` plus a live provider read-back so resume is safe by construction.

**v6.1+ ships with the engine ON by default** (flipped from v6.0's off-by-default after the stabilization criteria in [`docs/specs/v6.1-default-flip.md`](docs/specs/v6.1-default-flip.md) were met). Users who want the legacy v5.x output shape can opt out for one minor version via `--no-engine`, `CLAUDE_AUTOPILOT_ENGINE=off`, or `engine.enabled: false` — each prints a deprecation warning and is removed in v7.

→ [`docs/v6/quickstart.md`](docs/v6/quickstart.md) — five-minute setup
→ [`docs/v6/migration-guide.md`](docs/v6/migration-guide.md) — full v5.x → v6 walkthrough with precedence matrix, per-phase idempotency rules, and troubleshooting

## The pipeline, phase by phase

Each phase is a Claude Code skill (`.claude/skills/<name>/SKILL.md`). You can invoke any phase directly (`/brainstorm`, `/plan`, `/migrate`, `/validate`) without running the full pipeline. You can also rewire the pipeline by editing the `autopilot` skill.

| Phase | Skill | What it does | Model role |
|---|---|---|---|
| **Brainstorm** | `brainstorming` | Turns a rough idea into an approved spec through guided questions | Claude (implementation model) |
| **Spec review** | `codex-review` | Second model critiques the spec before you commit to it | Codex / GPT-5 |
| **Plan** | `writing-plans` | Breaks spec into phased, checklist-shaped implementation plan | Claude |
| **Plan review** | `codex-review` | Second model critiques the plan before you execute it | Codex / GPT-5 |
| **Implement** | `subagent-driven-development` | Executes plan in a git worktree, one phase at a time, with per-phase tests | Claude |
| **Migrate** | `migrate` | Dispatches to the configured migration skill (see [Migrate phase](#migrate-phase)) — runs your migration tool dev → QA → prod with per-env validation | Deterministic |
| **Validate** | `validate` | Static rules + tests + type check + security scan + LLM review | Any |
| **PR** | `commit-push-pr` | Opens the PR with auto-generated title, summary, and test plan | Claude |
| **Review** | `codex-pr-review` (default) or `council` (opt-in) | Sequential Codex pass on the diff with risk-tiered iteration count (1/2/3 passes for low/medium/high). Swap in `council` for parallel multi-model dispatch if you want higher rigor. | Codex (default) or multi-model |
| **Triage** | `bugbot` | Fetches automated reviewer findings, auto-fixes real bugs, dismisses false positives | Claude |
| **Deploy** (opt-in) | `deploy` | Deploys via configured adapter (`vercel` \| `fly` \| `render` \| `generic`) with optional log streaming, health check, and bounded auto-rollback (see [Deploy phase](#deploy-phase)). Not on the default `/autopilot` critical path: the autopilot loop ends at merge, and your CI/CD handles prod. Invoke `claude-autopilot deploy` directly, or wire it into the autopilot skill as Step 10. | Deterministic |

### Migrate phase

Configure your migration tool in `.autopilot/stack.md`. The pipeline reads stack.md, dispatches to the configured skill (`migrate@1` for generic; `migrate.supabase@1` for rich Supabase ledger; `none@1` to skip), and runs your tool with full safety: structured argv (no shell injection), 4-flag CI prod gate, hash-chained audit log. Run `claude-autopilot init` to auto-detect your stack — the detector recognizes Rails, Alembic, Django, Prisma, Drizzle, golang-migrate, dbmate, flyway, supabase-cli, ecto, typeorm, and falls back to a "configure manually" path. See [docs/skills/rich-migrate-contract.md](docs/skills/rich-migrate-contract.md) for the skill contract and [docs/skills/version-compatibility.md](docs/skills/version-compatibility.md) for the version model.

Generic example (Rails):

```yaml
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "rails", args: ["db:migrate"] }
      env_file: ".env.development"
    prod:
      command: { exec: "rails", args: ["db:migrate", "RAILS_ENV=production"] }
```

See `skills/migrate/SKILL.md` for examples covering Alembic, Django, Prisma, Drizzle, golang-migrate, dbmate, flyway, and custom scripts.

### Deploy phase

Configure your deploy target in `guardrail.config.yaml` under a `deploy:` block. Four adapters ship in 5.6:

- **`vercel`** — Vercel v13 deployments API. SSE+NDJSON log streaming, native rollback via `/promote`. Auth: `VERCEL_TOKEN`.
- **`fly`** — Fly.io Machines API. WebSocket log streaming, native rollback with simulated fallback. Auth: `FLY_API_TOKEN`. Requires the image to be pre-pushed (`fly deploy --build-only --push`).
- **`render`** — Render REST API. Polling-based log stream with `(timestamp, logId)` cursor dedup, simulated rollback (re-deploys prior commit). Auth: `RENDER_API_KEY`.
- **`generic`** — runs any shell `deployCommand` (`vercel --prod`, `kubectl apply`, `make deploy`, etc). No platform integration; `--watch` and `rollback` aren't supported.

Each adapter speaks the same `DeployAdapter` contract: `deploy()`, optional `status()` / `rollback()` / `streamLogs()`, plus a `capabilities` block (`streamMode: 'websocket' | 'polling' | 'none'`, `nativeRollback: boolean`) so the CLI can degrade UX honestly (polling adapters print a one-line stderr notice under `--watch`). Auto-rollback is bounded: max one rollback per deploy attempt, with `runHealthCheck` capped at 5×6s. Log lines emitted into PR comments run through a redaction pass (`AKIA…`, `sk-…`, `eyJ…`, `ghp_`, `xoxb-`, plus configurable patterns) so build output can't leak secrets.

Example (Fly):

```yaml
deploy:
  adapter: fly
  app: my-app
  image: registry.fly.io/my-app:latest
  region: ord
  watchBuildLogs: true
  healthCheckUrl: https://my-app.fly.dev/health
  rollbackOn: [healthCheckFailure]
```

`claude-autopilot doctor` checks for the relevant auth env var when an adapter is configured. See `docs/specs/v5.6-fly-render-adapters.md` for the full adapter contract.

## What's distinctive

Features that are hard or impossible to find in the competitive set:

- **Risk-tiered review depth (policy-driven).** Specs are tagged `risk: low | medium | high` in their frontmatter, with auto-escalation by keyword detection for sensitive categories (auth, multi-tenancy, sandboxing, billing, secrets, migrations, RLS, deploy/IAM, vector-DB tenancy — extend the list in the skill for your codebase). The pipeline runs 1 / 2 / 3 sequential Codex passes accordingly, each with a remediation cycle in between. Enforcement is encoded in `.claude/skills/autopilot/SKILL.md` (LLM-driven instructions, not a hard CLI gate), so it's auditable and editable. For teams that need hard enforcement, gate the merge step on the configured pass count by extending the skill or wrapping the CLI.
- **Retry-loop sameness detector.** Validate / Codex / bugbot retry loops compute a failure fingerprint before consuming each retry. If the same fingerprint fires twice in a row, the pipeline halts and surfaces it to you — instead of burning the remaining retry budget on attempts that are making no progress. Available as a public subpath import (`@delegance/claude-autopilot/run-state/sameness-detector`) for embedding into your own retry loops.
- **Multi-model council, available as a verb.** `claude-autopilot council` dispatches the same prompt to 3+ models in parallel and synthesizes the consensus. Opt-in for the autopilot pipeline (wire it into Step 7 of the autopilot skill), or invoke standalone for design decisions and architecture questions.
- **Fix with test verification.** `claude-autopilot fix --verify` runs your full test suite after every patch and reverts on failure. Safer than any tool that proposes fixes without running your tests.
- **Bug-bot auto-triage.** Watches Cursor BugBot / Copilot comments on your PR, triages each (real bug vs false positive), auto-fixes confirmed bugs, dismisses noise with explanations.
- **Schema alignment rule.** Ensures DB migrations, backend types, and frontend types stay in sync. Custom static rule, not something any competitor ships.
- **SARIF output + GitHub Code Scanning integration.** Findings appear as annotations in the PR and in the Security tab.

## Just the review layer

If you don't want the full pipeline, the review subcommands are a strict superset of what `guardrail run` used to do: LLM code review over git-changed files, SARIF output, inline PR comments, auto-fix, baselines, per-finding triage, cost budgets. The legacy `guardrail` CLI remains aliased to the review subcommands through v5.x.

```bash
claude-autopilot run                             # review changes since main
claude-autopilot run --inline-comments           # post per-line PR annotations
claude-autopilot run --format sarif --output out.sarif
claude-autopilot fix --verify                    # LLM patch + test gate + revert on fail
```

> **CLI note:** subcommands are flat (`run`, `scan`, `ci`, `fix`, `baseline`, `explain`, …). The grouped `claude-autopilot review <verb>` form is also accepted as an alias — flat and grouped both work.

## Install & requirements

```bash
npm install -g @delegance/claude-autopilot
```

- Node 22+
- `gh` CLI (for PR phases)
- One of: `ANTHROPIC_API_KEY` (recommended), `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `GROQ_API_KEY`
- Claude Code CLI (for skill-based phases — pipeline falls back to direct CLI invocations without it, but loses interactive checkpoints)
- `superpowers` Claude Code plugin (required for pipeline phases — `claude-autopilot doctor` will remediation-hint if missing)

---

---

## Config (`guardrail.config.yaml`)

```yaml
configVersion: 1
reviewEngine:
  adapter: auto        # auto-selects best available key at runtime
testCommand: npm test  # null to disable; used by `fix` verified mode

protectedPaths:
  - data/deltas/**
  - .github/workflows/**

staticRules:
  - hardcoded-secrets   # Anthropic, OpenAI, Stripe, GitHub, Supabase, Twilio, SendGrid
  - npm-audit
  - sql-injection       # template literals / concatenation in SQL context
  - missing-auth        # Next.js/pages API routes with POST/PUT/DELETE, no auth pattern
  - ssrf                # HTTP calls with user-controlled URL
  - insecure-redirect   # redirect() with user-controlled target
  - console-log
  - todo-fixme
  - large-file
  - missing-tests
  - package-lock-sync
  - brand-tokens        # opt-in: requires brand: block below

# Brand token enforcement (opt-in — omit to disable)
brand:
  colorsFrom: tailwind.config.ts   # auto-extract theme.colors as canonical palette
  colors:                          # explicit palette entries (merged with colorsFrom)
    - '#f97316'
    - '#1a1f3a'
  fonts:
    - 'Inter'
    - 'Geist'

policy:
  failOn: critical      # critical (default) | warning | note | none
  newOnly: false        # true = suppress findings present in .guardrail-baseline.json

cost:
  maxPerRun: 0.50       # abort review phase if spend exceeds $0.50
  estimateBeforeRun: false  # print token estimate before LLM calls

ignore:
  - src/legacy/**                              # suppress all findings in path
  - { rule: console-log, path: scripts/** }    # suppress specific rule in path

chunking:
  rateLimitBackoff: exp    # exp (default) | linear | none
  parallelism: 3
```

### Setup Profiles

`guardrail setup --profile <name>` overlays a pre-baked rule + policy configuration on top of the detected stack preset:

| Profile | Rules | `failOn` | Best for |
|---|---|---|---|
| `security-strict` | All security rules + hygiene | `warning` | Security audits, regulated environments |
| `team` | Core security + hygiene | `critical` | Standard CI/CD on shared branches |
| `solo` | Hygiene only | `critical` | Solo projects, low-noise baseline |

### Review Engine Adapters

| Adapter | Key required | Notes |
|---|---|---|
| `auto` | any | Auto-selects best available (recommended) |
| `claude` | `ANTHROPIC_API_KEY` | Claude Opus 4.7 |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Gemini 2.5 Pro, 1M context |
| `codex` | `OPENAI_API_KEY` | GPT-5 Codex |
| `bedrock` | AWS SDK default credential chain | AWS Bedrock — Claude Sonnet 4.5 default, streaming supported. Resolves credentials via the standard chain (ECS task role, EC2 instance metadata, EKS web identity, SSO, shared config, env vars). Optional `AWS_REGION` (default `us-east-1`). Install `@aws-sdk/client-bedrock-runtime`. |
| `azure` | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_DEPLOYMENT_NAME` | Azure OpenAI — deployment-routed (`/openai/deployments/{deployment}`). Default api-version `2024-10-21`. |
| `cohere` | `COHERE_API_KEY` | Cohere `command-r-plus-08-2024` default, streaming supported. Install `cohere-ai`. |
| `mistral` | `MISTRAL_API_KEY` | Mistral La Plateforme — `mistral-large-latest` default, streaming supported. Reuses OpenAI SDK. |
| `openai-compatible` | configurable | Any OpenAI-API-shape provider — see [OpenAI-compatible providers](#openai-compatible-providers) below. |

`auto` priority: Anthropic → Gemini → OpenAI → Groq.

#### OpenAI-compatible providers

The `openai-compatible` adapter speaks the standard OpenAI Chat Completions wire shape. Each of the providers below is configured via the OpenAI-compatible adapter — pick one, paste the snippet into `guardrail.config.yaml`, and set the named env var.

> **Security note.** `openai-compatible` accepts an arbitrary `baseUrl` and `apiKeyEnv` from your `guardrail.config.yaml`. The named env var's value is sent as the API key to that URL. **Only use `openai-compatible` with `guardrail.config.yaml` files you trust** — if an attacker can edit your config (e.g. via an unreviewed PR or untrusted repo), they can point `baseUrl` at an attacker-controlled endpoint and set `apiKeyEnv` to a sensitive variable name to exfiltrate it. Treat `guardrail.config.yaml` like any other secret-adjacent config file in code review. The direct provider adapters (`bedrock`, `azure`, `cohere`, `mistral`, `claude`, `gemini`, `codex`) use fixed env var names and fixed endpoints, so they are not subject to this concern.

| Provider | `baseUrl` | `apiKeyEnv` |
|---|---|---|
| Together AI | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` |
| Anyscale | `https://api.endpoints.anyscale.com/v1` | `ANYSCALE_API_KEY` |
| Fireworks | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| Perplexity | `https://api.perplexity.ai` | `PPLX_API_KEY` |
| DeepInfra | `https://api.deepinfra.com/v1/openai` | `DEEPINFRA_API_TOKEN` |
| Hyperbolic | `https://api.hyperbolic.xyz/v1` | `HYPERBOLIC_API_KEY` |
| Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| Ollama (local) | `http://localhost:11434/v1` | n/a (no key required) |

**Groq (fast/free tier):**
```yaml
reviewEngine:
  adapter: openai-compatible
  options:
    model: llama-3.3-70b-versatile
    baseUrl: https://api.groq.com/openai/v1
    apiKeyEnv: GROQ_API_KEY
```

**Together AI:**
```yaml
reviewEngine:
  adapter: openai-compatible
  options:
    model: meta-llama/Llama-3.3-70B-Instruct-Turbo
    baseUrl: https://api.together.xyz/v1
    apiKeyEnv: TOGETHER_API_KEY
```

**Anyscale:**
```yaml
reviewEngine:
  adapter: openai-compatible
  options:
    model: meta-llama/Meta-Llama-3-70B-Instruct
    baseUrl: https://api.endpoints.anyscale.com/v1
    apiKeyEnv: ANYSCALE_API_KEY
```

**Fireworks:**
```yaml
reviewEngine:
  adapter: openai-compatible
  options:
    model: accounts/fireworks/models/llama-v3p3-70b-instruct
    baseUrl: https://api.fireworks.ai/inference/v1
    apiKeyEnv: FIREWORKS_API_KEY
```

**OpenRouter (routes to 100+ models):**
```yaml
reviewEngine:
  adapter: openai-compatible
  options:
    model: anthropic/claude-3.5-sonnet
    baseUrl: https://openrouter.ai/api/v1
    apiKeyEnv: OPENROUTER_API_KEY
```

**Perplexity:**
```yaml
reviewEngine:
  adapter: openai-compatible
  options:
    model: llama-3.1-sonar-large-128k-online
    baseUrl: https://api.perplexity.ai
    apiKeyEnv: PPLX_API_KEY
```

**DeepInfra:**
```yaml
reviewEngine:
  adapter: openai-compatible
  options:
    model: meta-llama/Meta-Llama-3.1-70B-Instruct
    baseUrl: https://api.deepinfra.com/v1/openai
    apiKeyEnv: DEEPINFRA_API_TOKEN
```

**Hyperbolic:**
```yaml
reviewEngine:
  adapter: openai-compatible
  options:
    model: meta-llama/Meta-Llama-3.1-70B-Instruct
    baseUrl: https://api.hyperbolic.xyz/v1
    apiKeyEnv: HYPERBOLIC_API_KEY
```

**Ollama (local, no key):**
```yaml
reviewEngine:
  adapter: openai-compatible
  options:
    model: llama3.2
    baseUrl: http://localhost:11434/v1
```

#### Direct provider adapters

**AWS Bedrock:**
```yaml
reviewEngine:
  adapter: bedrock
  # Optional overrides — defaults shown:
  # options:
  #   model: anthropic.claude-sonnet-4-5-20250929-v1:0
  #   region: us-east-1
# Credentials: resolved via the AWS SDK default credential provider chain —
#   ECS task role / EC2 instance metadata / EKS web identity / SSO / shared
#   config / env vars (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, optionally
#   AWS_SESSION_TOKEN for STS). The secure pattern in ECS/EKS is to use a
#   task role and NOT set static keys in env.
# Optional: AWS_REGION (default us-east-1).
# Install: npm install @aws-sdk/client-bedrock-runtime
```

**Azure OpenAI:**
```yaml
reviewEngine:
  adapter: azure
# Env: AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT
#      (e.g. https://my-resource.openai.azure.com),
#      AZURE_OPENAI_DEPLOYMENT_NAME (deployment name, not model name).
# Optional: AZURE_OPENAI_API_VERSION (default 2024-10-21).
```

**Cohere:**
```yaml
reviewEngine:
  adapter: cohere
  # Optional:
  # options:
  #   model: command-r-plus-08-2024
# Env: COHERE_API_KEY
# Install: npm install cohere-ai
```

**Mistral:**
```yaml
reviewEngine:
  adapter: mistral
  # Optional:
  # options:
  #   model: mistral-large-latest
# Env: MISTRAL_API_KEY
# (Reuses the OpenAI SDK — no separate install required.)
```

---

## GitHub Actions

```yaml
- uses: axledbetter/claude-autopilot/.github/actions/ci@main
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    # Optional:
    # post-comments: 'true'
    # inline-comments: 'false'
    # base-ref: 'main'
    # sarif-output: 'guardrail.sarif'
    # version: 'latest'
```

Runs the pipeline, uploads SARIF to GitHub Code Scanning, annotates the PR diff inline.

---

## Typical Team Workflow

```bash
# 1. First run — establish a baseline so CI only fails on new issues
npx guardrail run --base main
npx guardrail baseline create --note "post-v2 audit"
git add .guardrail-baseline.json && git commit -m "chore: guardrail baseline"

# 2. CI — only new findings block the build
npx guardrail ci --new-only --fail-on critical

# 3. Triage false positives once, never see them again
npx guardrail triage sql-injection:src/db/raw.ts:47 false-positive --reason "internal admin only"
git add .guardrail-triage.json && git commit -m "chore: triage false positive"

# 4. Auto-fix and verify
npx guardrail fix --yes   # applies patches + runs tests, reverts on failure
```

---

## Interpreting Results

**Exit 0** — pass or warnings only (at current `policy.failOn` threshold). Safe to merge.  
**Exit 1** — findings at or above threshold. Fix before merging.

Findings: `critical` blocks merge · `warning` should fix · `note` informational.

PR comments show: status badge, phase table, critical/warning findings with inline links, cost footer. Re-runs update the existing comment in place.

---

## Architecture

Four pluggable adapter points:

| Point | Built-in | Purpose |
|---|---|---|
| `review-engine` | `auto`, `claude`, `gemini`, `codex`, `bedrock`, `azure`, `cohere`, `mistral`, `openai-compatible` | LLM review (16+ providers — see [Review Engine Adapters](#review-engine-adapters)) |
| `vcs-host` | `github` | PR comments + SARIF |
| `migration-runner` | `supabase` | DB migrations |
| `review-bot-parser` | `cursor` | Parse review bot comments |

**Monorepo:** Auto-detects npm/yarn/pnpm workspaces, Turborepo, and Nx.

## Reproducing the benchmark

The 13/13 benchmark cited in the [Benchmark](#benchmark) section is reproducible end-to-end. The fixture is a minimal Next.js app that seeds each of the README-advertised bug categories at a specific file:line, then `claude-autopilot scan --all` is run with the `claude` adapter and the result is compared to the seed list.

```bash
# 1. Install the CLI
npm install -g @delegance/claude-autopilot

# 2. Seed the fixture (one file per bug category)
SEED=$(mktemp -d) && cd $SEED && npm init -y >/dev/null
mkdir -p app/api/{users,coupons,profile,redirect,proxy} lib

# (Add the 13 seeded files — the canonical fixture lives at
#  https://github.com/axledbetter/claude-autopilot/tree/master/tests/v4-compat/fixtures/13-bugs)

# 3. Init + scan
claude-autopilot init --preset nextjs-supabase
ANTHROPIC_API_KEY=sk-ant-... claude-autopilot scan --all
```

**What "13 of 13" means:** the scan output flags each category as a distinct critical or warning finding with file path, line, and concrete remediation. We count one hit per seed regardless of severity bucket. The categories are: SQL injection, hardcoded secret, missing auth, IDOR, CORS wildcard, SSRF, open redirect, TOCTOU race, silent error swallow, off-by-one, missing rate limit, console.log in prod, missing input validation.

**What this doesn't measure:**
- False positive rate on a clean repo (separate test, expected ~3 findings on real production code per the cold-start eval)
- Detection rate with cheaper models — this is Claude Opus. Sonnet typically catches 11/13. Llama 3.3 70B (via Groq) caught 8/13 in independent testing
- Bugs the scan missed: there are none in the 13-category set we measure, but real production bugs are not always in this set

We do not claim 13/13 reflects every real-world repo — it's a reproducible upper bound on a fixture that exercises the categories we explicitly target.

## What's Next (v8.0.0)

v7.8.0 begins decoupling runtime deps so local-only users can install a
leaner package:

- **`tsx` is being removed from `dependencies` in v8.0.0.** Today it ships
  bundled and the launcher prefers a project-local install if you have one,
  falling back to the bundled copy with a once-per-day deprecation warning.
  In v8.0.0 the bundled fallback goes away — install `tsx` locally
  (`npm install -D tsx`) or set `CLAUDE_AUTOPILOT_TSX=path` to use a global
  install.
- **The hosted-dashboard upload is moving to a separate optional package
  (`@delegance/claude-autopilot-cloud`)** so you can skip Supabase entirely
  with `npm install --omit=optional` today, and skip the dep entirely with
  v8.0.0. The smoke workflow `.github/workflows/omit-optional-smoke.yml`
  verifies the install-with-omit path on every PR.

Track the v8.0.0 plan and request comments at https://github.com/axledbetter/claude-autopilot/issues

## Contributing

Issues and PRs welcome — https://github.com/axledbetter/claude-autopilot/issues. The pipeline literally builds itself; many features in this repo were implemented by autopilot running against autopilot ([DEMO.md](DEMO.md) walks through six self-eat PRs with cost trajectory $10 → ~$2.50). Read [CONTRIBUTING.md](CONTRIBUTING.md) if it exists, otherwise: clone, `npm install`, `npm test`, open a PR.

## License

MIT — see [LICENSE](LICENSE).
