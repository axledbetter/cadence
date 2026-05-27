---
title: Per-Phase Provider Routing in Profile YAML
date: 2026-05-27
risk_tier: medium
status: design
---

# Per-Phase Provider Routing in Profile YAML

## Why

The v8.4.0 DEV.to launch article (and the README) promised that Cadence supports per-phase provider routing in profile YAML:

```yaml
phases:
  implement:    { provider: anthropic, model: claude-opus-4-7 }
  review:       { provider: openai,    model: gpt-5.5 }
  council:      { provider: google,    model: gemini-2.5-pro }
  bugbot_triage:{ provider: anthropic, model: claude-haiku-4-5 }
```

But the actual `presets/profiles/solo.yaml` schema only has `codex_passes`, `auto_merge`, `pause_at_steps`, `contributor_policy`. Per-phase routing today happens via env vars (`CODEX_MODEL`) and hardcoded adapter defaults, not via YAML. This spec closes that gap so the marketing claim becomes true.

## Goal

Add a `phases` field to the profile schema that overrides which provider+model each phase uses. Precedence: `profile.phases.<phase>` > env var > adapter default.

## Non-goals

- Per-PR phase overrides (use profile-per-project)
- Per-task model routing inside a single phase (out of scope)
- Provider authentication/credential management (env vars stay as-is)
- New providers (use existing 16+ adapters)

## Architecture

```
profile.yaml
  └── phases:
        ├── implement      → src/core/autopilot/dispatch.ts (Claude Code subagent)
        ├── review         → src/adapters/review-engine/codex.ts
        ├── council        → src/adapters/review-engine/gemini.ts (+ openai/claude)
        └── bugbot_triage  → scripts/bugbot.ts triage step

Resolution order (each phase, each call):
  1. profile.phases.<phase>.{provider,model}  (this PR)
  2. <PHASE>_MODEL / <PHASE>_PROVIDER env var (this PR — new, normalized)
  3. CODEX_MODEL / etc. (legacy env vars — preserved)
  4. adapter DEFAULT_MODEL constant         (existing)
```

## Components

### 1. Schema extension (`presets/schemas/profile.schema.json`)

Add to root properties:

```json
"phases": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "implement":     { "$ref": "#/$defs/phaseRoute" },
    "review":        { "$ref": "#/$defs/phaseRoute" },
    "council":       { "$ref": "#/$defs/phaseRoute" },
    "bugbot_triage": { "$ref": "#/$defs/phaseRoute" }
  }
},
"$defs": {
  "phaseRoute": {
    "type": "object",
    "additionalProperties": false,
    "required": ["provider"],
    "properties": {
      "provider": {
        "type": "string",
        "enum": ["anthropic","openai","google","groq","ollama","bedrock","azure","cohere","mistral","deepseek","together","fireworks","perplexity","openrouter","xai","openai-compatible"]
      },
      "model":   { "type": "string", "minLength": 1 },
      "baseUrl": { "type": "string", "format": "uri" }
    }
  }
}
```

### 2. Resolver (`src/core/profile/resolve-phase-route.ts` — new)

```typescript
export type PhaseName = 'implement' | 'review' | 'council' | 'bugbot_triage';

export interface ResolvedPhaseRoute {
  provider: string;
  model: string;
  baseUrl?: string;
  source: 'profile' | 'env' | 'default';
}

export function resolvePhaseRoute(
  phase: PhaseName,
  profile: { phases?: Record<string, PhaseRoute> },
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPhaseRoute;
```

Precedence implementation:
- `profile.phases[phase]?.provider/model` → source: `'profile'`
- `env[<PHASE>_PROVIDER]` + `env[<PHASE>_MODEL]` → source: `'env'` (e.g. `REVIEW_PROVIDER=openai`, `REVIEW_MODEL=gpt-5.5`)
- legacy `CODEX_MODEL`, `BUGBOT_MODEL` env vars → source: `'env'` (back-compat)
- adapter DEFAULT_MODEL → source: `'default'`

### 3. Wire into existing adapter call sites

- `src/adapters/review-engine/codex.ts` — replace `process.env.CODEX_MODEL ?? 'gpt-5.5'` with `resolvePhaseRoute('review', profile, process.env)`.
- `src/adapters/review-engine/gemini.ts` — same shape, for `council` phase.
- `src/adapters/review-engine/claude.ts` — same shape, when Anthropic is selected for council.
- `scripts/bugbot.ts` triage call site — use `resolvePhaseRoute('bugbot_triage', ...)`.
- `implement` phase: the subagent dispatcher (`src/core/autopilot/dispatch.ts` or skill-side) reads the route and surfaces it as guidance — Claude Code subagents inherit the runtime model, but the dispatcher logs the configured route so observability is correct.

### 4. CLI surface — `cadence routes` (new verb)

```bash
$ cadence routes
implement      anthropic / claude-opus-4-7      (default)
review         openai / gpt-5.5                 (profile)
council        google / gemini-2.5-pro          (profile)
bugbot_triage  anthropic / claude-haiku-4-5     (env: BUGBOT_MODEL)
```

Reads the active profile + env, prints the resolved route for each phase with source attribution. Useful for "is my profile YAML actually being read?" sanity checks.

### 5. README + profile updates

- Add a "Provider routing" section to README.md showing the YAML override pattern with a worked example.
- Update `presets/profiles/oss-maintainer.yaml` with a commented `phases:` block (no behavior change — just discoverability).
- Update `presets/profiles/enterprise.yaml` likewise.
- `solo.yaml` stays minimal (defaults).

## Data flow

1. `cadence autopilot <spec.md>` loads profile via existing profile loader.
2. Each phase entry point (review, council, bugbot triage, implement dispatch) calls `resolvePhaseRoute(phase, profile)` before invoking its adapter.
3. The adapter receives the resolved `{provider, model, baseUrl}` and uses it (no further env-var lookup).
4. Run-state events (if #180 is also shipped) include the resolved route in `phase.start` payload for debuggability.

## Error handling

- Unknown provider in YAML → schema validation fails at profile load (loud, blocking).
- Provider not installed (e.g. `cohere` selected but `cohere-ai` not in optionalDependencies) → adapter throws `MissingProviderError` with install hint. Pre-existing behavior; just surface it earlier in the resolver if possible.
- Env var without profile entry → still works (env wins over default).
- Both env + profile set → profile wins; log the precedence at debug level.
- `baseUrl` provided but provider doesn't support it (e.g. `anthropic` with custom baseUrl) → warn, ignore baseUrl, proceed.

## Testing

New test file: `tests/profile/resolve-phase-route.test.ts`

1. Profile entry overrides env var.
2. Env var overrides default.
3. Legacy `CODEX_MODEL` still respected for `review` phase when no `REVIEW_MODEL` and no `profile.phases.review`.
4. Unknown provider in YAML rejected by schema validation.
5. Missing `model` field falls back to adapter default (provider-only override).
6. `cadence routes` CLI prints all 4 phases with correct source attribution.

Existing tests stay green: `tests/config-schema.test.ts`, `tests/council/config.test.ts`, codex adapter tests.

## Backward compatibility

- Profiles without `phases:` block behave identically to today (precedence falls through to env+default).
- Legacy env vars (`CODEX_MODEL`, etc.) preserved indefinitely.
- New `<PHASE>_MODEL` / `<PHASE>_PROVIDER` env vars are additive — no existing env var is renamed or deprecated.

## Out of scope (future work)

- Per-tier routing (e.g. high-risk specs use Opus, low-risk use Haiku) — interesting but a follow-up.
- Council pool composition (today: one model; future: 2-3 advisors + synthesizer, each with their own route).
- Cost budgeting per phase (`max_usd_per_phase`).
