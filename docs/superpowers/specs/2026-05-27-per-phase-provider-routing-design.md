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
        ├── review         → invokeReview(route, input)        → adapter selected by route.provider
        ├── council        → invokeCouncil(route, input)       → adapter selected by route.provider
        └── bugbot_triage  → invokeBugbotTriage(route, input)  → adapter selected by route.provider

(implement is NOT in this set — see "Implement phase is observed-only" below.)

Resolution order (per phase, per field):
  provider:  profile.phases.<phase>.provider
          → env.<PHASE>_PROVIDER (new, normalized)
          → phase default provider (e.g. review → openai)
  model:     profile.phases.<phase>.model
          → env.<PHASE>_MODEL (new, normalized)
          → legacy env (CODEX_MODEL for review, BUGBOT_MODEL for bugbot_triage)
          → providerRegistry.defaultModelFor(phase, provider)
  baseUrl:   profile.phases.<phase>.baseUrl
          → env.<PHASE>_BASE_URL
          → adapter default (provider-dependent; ignored if provider doesn't support custom endpoints)
```

### Phase dispatcher pattern (load-bearing)

The CRITICAL change vs the original design: provider routing happens at a **phase-level dispatcher**, not inside provider-specific adapters. Provider-specific adapters become "given an already-resolved (provider, model, baseUrl), make the call" and stop being responsible for "am I the right provider."

```typescript
// src/core/phases/dispatch.ts (new)
export async function invokeReview(route: ResolvedPhaseRoute, input: ReviewInput): Promise<ReviewOutput> {
  switch (route.provider) {
    case 'openai':       return openaiReview(route, input);
    case 'anthropic':    return claudeReview(route, input);
    case 'google':       return geminiReview(route, input);
    case 'groq':         return groqReview(route, input);
    case 'bedrock':      return bedrockReview(route, input);
    // ... 16 cases ...
    default: throw new UnsupportedProviderError(route.provider, 'review');
  }
}
// Same shape for invokeCouncil, invokeBugbotTriage.
```

Existing adapter call sites (`src/adapters/review-engine/codex.ts`, `gemini.ts`, `claude.ts`) become per-provider implementations called BY the dispatcher, not the entry points. Their `DEFAULT_MODEL` constants move into the providerRegistry.

### Implement phase is observed-only

Claude Code subagents inherit the runtime model from the Claude Code session — Cadence cannot override it from outside. So `implement` is intentionally NOT a routed phase in v1. The profile schema does NOT accept `phases.implement`, and `cadence routes` lists `implement` separately as "runtime-bound (Claude Code session model)" so users don't think their YAML is being ignored.

If we add a runtime-config hook into Claude Code later, this can be promoted to a routed phase. Until then, the dispatcher only logs what model Claude Code is using for observability.

## Components

### 1. Schema extension (`presets/schemas/profile.schema.json`)

Add to root properties (merging with any existing `$defs` rather than replacing):

```json
"phases": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "review":        { "$ref": "#/$defs/phaseRoute" },
    "council":       { "$ref": "#/$defs/phaseRoute" },
    "bugbot_triage": { "$ref": "#/$defs/phaseRoute" }
  }
}
```

And inside the existing `$defs` (do NOT replace the root `$defs` block):

```json
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
```

Note: `implement` is intentionally absent from the schema — runtime-bound to the Claude Code session. `provider` is required so we never have ambiguous provider inference; model-only overrides go through env vars (legacy compatibility).

### 2. Provider registry (`src/core/phases/provider-registry.ts` — new)

The registry is the single source of truth for "what providers exist, what's their default model per phase, do they support custom baseUrl, are they installed."

```typescript
export type PhaseName = 'review' | 'council' | 'bugbot_triage';

export interface ProviderCapability {
  id: string;                           // 'anthropic' | 'openai' | ...
  installed: boolean;                   // optionalDependencies check
  supportsBaseUrl: boolean;
  defaultModelByPhase: Partial<Record<PhaseName, string>>;
}

export const PROVIDER_REGISTRY: Record<string, ProviderCapability> = {
  openai: {
    id: 'openai', installed: hasModule('openai'), supportsBaseUrl: true,
    defaultModelByPhase: { review: 'gpt-5.5', council: 'gpt-5.5', bugbot_triage: 'gpt-5.5' },
  },
  anthropic: {
    id: 'anthropic', installed: hasModule('@anthropic-ai/sdk'), supportsBaseUrl: false,
    defaultModelByPhase: { review: 'claude-opus-4-7', council: 'claude-opus-4-7', bugbot_triage: 'claude-haiku-4-5' },
  },
  google: {
    id: 'google', installed: hasModule('@google/generative-ai'), supportsBaseUrl: false,
    defaultModelByPhase: { review: 'gemini-2.5-pro-preview-05-06', council: 'gemini-2.5-pro-preview-05-06' },
  },
  // ... 13 more ...
};

export function defaultPhaseProvider(phase: PhaseName): string {
  // Hardcoded sensible defaults so resolver can produce a route with zero config:
  return { review: 'openai', council: 'google', bugbot_triage: 'anthropic' }[phase];
}
```

### 3. Resolver (`src/core/phases/resolve-phase-route.ts` — new)

```typescript
export interface ResolvedPhaseRoute {
  provider: string;
  model: string;
  baseUrl?: string;
  sources: {
    provider: 'profile' | 'env' | 'default';
    model:    'profile' | 'env' | 'legacy-env' | 'default';
    baseUrl?: 'profile' | 'env' | 'default';
  };
}

export function resolvePhaseRoute(
  phase: PhaseName,
  profile: { phases?: Record<string, PhaseRoute> },
  registry: Record<string, ProviderCapability> = PROVIDER_REGISTRY,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPhaseRoute;
```

Per-field resolution (resolve provider first, then model relative to that provider):

1. **provider**: `profile.phases[phase]?.provider` → `env[<PHASE>_PROVIDER]` (e.g. `REVIEW_PROVIDER`) → `defaultPhaseProvider(phase)`.
2. **model**: `profile.phases[phase]?.model` → `env[<PHASE>_MODEL]` (e.g. `REVIEW_MODEL`) → legacy env (`CODEX_MODEL` for review, `BUGBOT_MODEL` for bugbot_triage) → `registry[provider].defaultModelByPhase[phase]`.
3. **baseUrl**: `profile.phases[phase]?.baseUrl` → `env[<PHASE>_BASE_URL]` → none. If provider's `supportsBaseUrl: false` and baseUrl is set anywhere, warn and drop.

Validation at resolve time:
- Provider unknown → throw schema validation error (already caught at profile load, but defensive).
- Provider known but `installed: false` → throw `MissingProviderError` with install hint.

### 4. Wire into phase dispatchers (NOT inside provider-specific adapters)

- `src/core/phases/dispatch.ts` (new) — `invokeReview/Council/BugbotTriage` switch on `route.provider`, call the right adapter with already-resolved `(model, baseUrl)`.
- `scripts/bugbot.ts` triage call site — call `invokeBugbotTriage(resolvePhaseRoute('bugbot_triage', profile, registry, process.env), input)`.
- Codex-review and council call sites move to call `invokeReview` / `invokeCouncil` instead of the per-provider adapter directly.
- Existing per-provider adapters (`codex.ts`, `gemini.ts`, `claude.ts`) are refactored to accept `{ model, baseUrl }` from the dispatcher; their internal `DEFAULT_MODEL` constants are removed (registry owns defaults).

### 5. CLI surface — `cadence routes` (new verb)

```bash
$ cadence routes
implement      runtime-bound (Claude Code session model)
review         openai / gpt-5.5                 (provider: profile, model: profile)
council        google / gemini-2.5-pro          (provider: profile, model: default)
bugbot_triage  anthropic / claude-haiku-4-5     (provider: default, model: legacy-env BUGBOT_MODEL)
```

Reads the active profile + env, prints the resolved route for each phase with source attribution. Useful for "is my profile YAML actually being read?" sanity checks.

### 6. README + profile updates

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

**Resolver tests** — `tests/phases/resolve-phase-route.test.ts`:

1. Profile entry overrides env var.
2. Env var overrides default.
3. Legacy `CODEX_MODEL` still respected for `review` phase when no `REVIEW_MODEL` and no `profile.phases.review` → `sources.model === 'legacy-env'`.
4. Unknown provider in YAML rejected by schema validation.
5. Provider-only profile override (no `model`) → resolves model from `registry[provider].defaultModelByPhase[phase]`, `sources.model === 'default'`.
6. Provider-only env override (`REVIEW_PROVIDER=anthropic` no `REVIEW_MODEL`) → model resolves to Anthropic's default review model, NOT OpenAI's.
7. `baseUrl` set on a provider with `supportsBaseUrl: false` → warning logged, baseUrl dropped from resolved route.

**Dispatcher tests** — `tests/phases/dispatch.test.ts` (the load-bearing tests that prove routing actually works):

8. `invokeReview` with `provider: anthropic` calls the Claude review adapter, NOT codex.
9. `invokeCouncil` with `provider: google` calls the Gemini adapter.
10. `invokeBugbotTriage` with `provider: openai` calls the OpenAI adapter.
11. Unsupported provider for phase (e.g. `provider: ollama, phase: council` if council needs structured output ollama can't reliably do) → `UnsupportedProviderError` BEFORE any network call.

**CLI test** — `tests/cli/routes.test.ts`:

12. `cadence routes` prints `implement` as `runtime-bound`, prints 3 routed phases with per-field source attribution.

**Registry test** — `tests/phases/provider-registry.test.ts`:

13. All 16 providers have `defaultModelByPhase` for review at minimum.
14. `installed` reflects actual `optionalDependencies` state.

Existing tests stay green: `tests/config-schema.test.ts`, `tests/council/config.test.ts`, codex adapter tests.

## Backward compatibility

- Profiles without `phases:` block behave identically to today (precedence falls through to env+default).
- Legacy env vars (`CODEX_MODEL`, etc.) preserved indefinitely.
- New `<PHASE>_MODEL` / `<PHASE>_PROVIDER` env vars are additive — no existing env var is renamed or deprecated.

## Out of scope (future work)

- Per-tier routing (e.g. high-risk specs use Opus, low-risk use Haiku) — interesting but a follow-up.
- Council pool composition (today: one model; future: 2-3 advisors + synthesizer, each with their own route).
- Cost budgeting per phase (`max_usd_per_phase`).
- `implement` phase routing (requires Claude Code runtime-config hook that doesn't exist yet).

## Post-launch follow-ups (codex WARNINGs/NOTEs to revisit)

- **Active profile propagation** — `scripts/bugbot.ts` and other standalone scripts need a documented way to select the active profile (CLI flag vs env var vs default). Spec'd implicitly here; formalize in a follow-up.
- **`baseUrl` allowlist for high-sensitivity deployments** — accepting arbitrary `baseUrl` from profile YAML is a potential exfiltration vector for sensitive source. Consider `ALLOWED_PROVIDER_BASE_URLS` env or org policy file.
- **Adapter integration tests** — beyond the dispatcher unit tests, add a smoke job that round-trips a real call to each installed provider's adapter to catch silent breakage.
- **Schema merge audit** — when adding `phaseRoute` to `$defs`, manually verify existing `$defs` keys aren't accidentally clobbered.
