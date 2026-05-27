---
title: Per-Phase Provider Routing — Implementation Plan
date: 2026-05-27
spec: docs/superpowers/specs/2026-05-27-per-phase-provider-routing-design.md
risk_tier: medium
status: ready-to-implement
---

# Per-Phase Provider Routing — Implementation Plan

Bite-sized TDD plan. Each step has a writeable test, a writeable implementation, and a verifiable green run. The dispatcher pattern (resolve → switch on `provider` → call already-resolved adapter) is the load-bearing decision and gets implemented before any adapter refactor so the existing call sites stay green throughout.

## Order of operations

1. **Schema first** — add `phases` + `phaseRoute` to `presets/schemas/profile.schema.json`. No code consumes it yet; this is just the contract.
2. **Profile type** — extend `src/core/profile/types.ts` with optional `phases?` field. Resolver doesn't need to change (`additionalProperties: false` already validates).
3. **Provider registry** — `src/core/phases/provider-registry.ts` lists 16 providers with default models per phase + installed check.
4. **Resolver** — `src/core/phases/resolve-phase-route.ts` with per-field source attribution. Pure function. 7 unit tests.
5. **Dispatcher** — `src/core/phases/dispatch.ts` exports `invokeReview / invokeCouncil / invokeBugbotTriage`. Each switches on `route.provider`. 4 unit tests, mocking adapters at the module-loader boundary.
6. **Adapter refactor** — `codex.ts`, `claude.ts`, `gemini.ts` no longer own `DEFAULT_MODEL`. They accept `{ model, baseUrl }` via existing `input.context` path (which gemini and claude already read). Codex gets the same treatment.
7. **CLI verb** — `cadence routes` (new `src/cli/routes.ts`, wired into `src/cli/index.ts` switch). One smoke test using the same `spawnSync` pattern as `tests/cli/profile.test.ts`.
8. **Profile YAML** — `oss-maintainer.yaml` and `enterprise.yaml` get a **commented-out** example `phases:` block.
9. **README** — append a "Provider routing" section.

Existing tests (`config-schema`, `council/config`, `claude-adapter`, `codex` if present, `gemini`) must stay green. Step 6 is the only step that could break existing tests — if so, fix the test by passing a `context.model` instead of relying on the removed default constant.

## Step 1 — Schema extension

**File**: `presets/schemas/profile.schema.json`

Add `phases` to `properties` (do NOT touch existing keys) and add `$defs` at root with the `phaseRoute` sub-schema. The current schema has no `$defs` block yet — adding one is greenfield, no merge needed.

Patch (conceptual):

```json
{
  "...existing properties...": {},
  "phases": {
    "type": "object",
    "additionalProperties": false,
    "description": "Per-phase provider routing override. Each routed phase (review, council, bugbot_triage) can pin its own provider + model. `implement` is intentionally absent — Claude Code's session model is not overridable from outside.",
    "properties": {
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
          "enum": [
            "anthropic","openai","google","groq","ollama","bedrock",
            "azure","cohere","mistral","deepseek","together","fireworks",
            "perplexity","openrouter","xai","openai-compatible"
          ]
        },
        "model":   { "type": "string", "minLength": 1 },
        "baseUrl": { "type": "string", "format": "uri" }
      }
    }
  }
}
```

**Test**: extend `tests/config-schema.test.ts` (or add to `tests/cli/profile.test.ts`) — assert that a profile YAML with a valid `phases.review.provider: openai` block loads, and that `phases.review.provider: bogus-provider` throws schema_violation.

Actually — `tests/config-schema.test.ts` is for the **guardrail.config.yaml** not the profile schema. The relevant tests live in `tests/profile/` (a directory). Add a focused unit there:

`tests/profile/schema-phases.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _loadProfileByNameForTest } from '../../src/core/profile/resolver.ts';

// Helper writes a temp profile dir; the resolver's package-root override
// reads presets/profiles from there.
function writeProfile(name: string, body: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phases-schema-'));
  fs.mkdirSync(path.join(root, 'presets', 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(root, 'presets', 'profiles', `${name}.yaml`), body, 'utf8');
  // Copy the real schema in so the resolver can find it.
  fs.mkdirSync(path.join(root, 'presets', 'schemas'), { recursive: true });
  fs.copyFileSync(
    path.resolve('presets/schemas/profile.schema.json'),
    path.join(root, 'presets', 'schemas', 'profile.schema.json'),
  );
  return root;
}

describe('profile schema — phases block', () => {
  it('accepts a phases block with valid provider', () => {
    const root = writeProfile('phasey', [
      'profile: phasey',
      'description: test',
      'codex_passes: { low: 1, medium: 1, high: 1 }',
      'phases:',
      '  review: { provider: openai }',
    ].join('\n'));
    const cfg = _loadProfileByNameForTest('phasey', { packageRoot: root });
    assert.equal((cfg as any).phases?.review?.provider, 'openai');
  });

  it('rejects an unknown provider with schema_violation', () => {
    const root = writeProfile('phasey', [
      'profile: phasey',
      'description: test',
      'codex_passes: { low: 1, medium: 1, high: 1 }',
      'phases:',
      '  review: { provider: bogus-provider }',
    ].join('\n'));
    assert.throws(() => _loadProfileByNameForTest('phasey', { packageRoot: root }), /schema/i);
  });
});
```

(The test uses `_loadProfileByNameForTest` which already exists in `resolver.ts`.)

**Also**: add `phases?: Record<string, { provider: string; model?: string; baseUrl?: string }>` to `ProfileConfig` in `src/core/profile/types.ts` so TypeScript consumers see it.

## Step 2 — Provider registry

**File**: `src/core/phases/provider-registry.ts` (new)

```typescript
/**
 * Phase routing — provider registry.
 *
 * Single source of truth for what providers exist, what their default model
 * is per phase, whether they support a custom baseUrl, and whether the
 * required SDK is installed. Consumed by `resolvePhaseRoute` and `cadence
 * routes`.
 */
import { createRequire } from 'node:module';

export type PhaseName = 'review' | 'council' | 'bugbot_triage';

export interface ProviderCapability {
  id: string;
  installed: boolean;
  supportsBaseUrl: boolean;
  defaultModelByPhase: Partial<Record<PhaseName, string>>;
}

const _require = createRequire(import.meta.url);
function hasModule(pkg: string): boolean {
  try { _require.resolve(pkg); return true; } catch { return false; }
}

export const PROVIDER_REGISTRY: Record<string, ProviderCapability> = {
  openai: {
    id: 'openai',
    installed: hasModule('openai'),
    supportsBaseUrl: true,
    defaultModelByPhase: { review: 'gpt-5.5', council: 'gpt-5.5', bugbot_triage: 'gpt-5.5' },
  },
  anthropic: {
    id: 'anthropic',
    installed: hasModule('@anthropic-ai/sdk'),
    supportsBaseUrl: false,
    defaultModelByPhase: {
      review: 'claude-opus-4-7',
      council: 'claude-opus-4-7',
      bugbot_triage: 'claude-haiku-4-5',
    },
  },
  google: {
    id: 'google',
    installed: hasModule('@google/generative-ai'),
    supportsBaseUrl: false,
    defaultModelByPhase: {
      review: 'gemini-2.5-pro-preview-05-06',
      council: 'gemini-2.5-pro-preview-05-06',
      bugbot_triage: 'gemini-2.5-flash',
    },
  },
  groq: {
    id: 'groq', installed: hasModule('openai'), supportsBaseUrl: true,
    defaultModelByPhase: {
      review: 'llama-3.3-70b-versatile',
      council: 'llama-3.3-70b-versatile',
      bugbot_triage: 'llama-3.3-70b-versatile',
    },
  },
  ollama: {
    id: 'ollama', installed: hasModule('openai'), supportsBaseUrl: true,
    defaultModelByPhase: { review: 'llama3.3', council: 'llama3.3', bugbot_triage: 'llama3.3' },
  },
  bedrock: {
    id: 'bedrock', installed: hasModule('@aws-sdk/client-bedrock-runtime'), supportsBaseUrl: false,
    defaultModelByPhase: {
      review: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      council: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      bugbot_triage: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    },
  },
  azure: {
    id: 'azure', installed: hasModule('openai'), supportsBaseUrl: true,
    defaultModelByPhase: { review: 'gpt-5.5', council: 'gpt-5.5', bugbot_triage: 'gpt-5.5' },
  },
  cohere: {
    id: 'cohere', installed: hasModule('cohere-ai'), supportsBaseUrl: false,
    defaultModelByPhase: { review: 'command-r-plus', council: 'command-r-plus', bugbot_triage: 'command-r' },
  },
  mistral: {
    id: 'mistral', installed: hasModule('openai'), supportsBaseUrl: true,
    defaultModelByPhase: { review: 'mistral-large-latest', council: 'mistral-large-latest', bugbot_triage: 'mistral-small-latest' },
  },
  deepseek: {
    id: 'deepseek', installed: hasModule('openai'), supportsBaseUrl: true,
    defaultModelByPhase: { review: 'deepseek-chat', council: 'deepseek-chat', bugbot_triage: 'deepseek-chat' },
  },
  together: {
    id: 'together', installed: hasModule('openai'), supportsBaseUrl: true,
    defaultModelByPhase: { review: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', council: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', bugbot_triage: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  },
  fireworks: {
    id: 'fireworks', installed: hasModule('openai'), supportsBaseUrl: true,
    defaultModelByPhase: { review: 'accounts/fireworks/models/llama-v3p3-70b-instruct', council: 'accounts/fireworks/models/llama-v3p3-70b-instruct', bugbot_triage: 'accounts/fireworks/models/llama-v3p3-70b-instruct' },
  },
  perplexity: {
    id: 'perplexity', installed: hasModule('openai'), supportsBaseUrl: true,
    defaultModelByPhase: { review: 'sonar-pro', council: 'sonar-pro', bugbot_triage: 'sonar' },
  },
  openrouter: {
    id: 'openrouter', installed: hasModule('openai'), supportsBaseUrl: true,
    defaultModelByPhase: { review: 'anthropic/claude-opus-4-7', council: 'anthropic/claude-opus-4-7', bugbot_triage: 'anthropic/claude-haiku-4-5' },
  },
  xai: {
    id: 'xai', installed: hasModule('openai'), supportsBaseUrl: true,
    defaultModelByPhase: { review: 'grok-2-latest', council: 'grok-2-latest', bugbot_triage: 'grok-2-latest' },
  },
  'openai-compatible': {
    id: 'openai-compatible', installed: hasModule('openai'), supportsBaseUrl: true,
    defaultModelByPhase: { review: 'gpt-5.5', council: 'gpt-5.5', bugbot_triage: 'gpt-5.5' },
  },
};

export function defaultPhaseProvider(phase: PhaseName): string {
  const map: Record<PhaseName, string> = {
    review: 'openai',
    council: 'google',
    bugbot_triage: 'anthropic',
  };
  return map[phase];
}
```

**Test**: `tests/phases/provider-registry.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_REGISTRY } from '../../src/core/phases/provider-registry.ts';

describe('provider registry', () => {
  it('has at least 16 providers', () => {
    assert.ok(Object.keys(PROVIDER_REGISTRY).length >= 16);
  });
  it('every provider has a review default model', () => {
    for (const [id, cap] of Object.entries(PROVIDER_REGISTRY)) {
      assert.ok(cap.defaultModelByPhase.review, `provider ${id} missing review default`);
    }
  });
});
```

## Step 3 — Resolver

**File**: `src/core/phases/resolve-phase-route.ts` (new)

```typescript
import {
  PROVIDER_REGISTRY,
  defaultPhaseProvider,
  type PhaseName,
  type ProviderCapability,
} from './provider-registry.ts';
import { GuardrailError } from '../errors.ts';

export interface PhaseRoute {
  provider: string;
  model?: string;
  baseUrl?: string;
}

export interface ResolvedPhaseRoute {
  provider: string;
  model: string;
  baseUrl?: string;
  sources: {
    provider: 'profile' | 'env' | 'default';
    model: 'profile' | 'env' | 'legacy-env' | 'default';
    baseUrl?: 'profile' | 'env';
  };
}

const PHASE_ENV_PREFIX: Record<PhaseName, string> = {
  review: 'REVIEW',
  council: 'COUNCIL',
  bugbot_triage: 'BUGBOT',
};

const LEGACY_MODEL_ENV: Partial<Record<PhaseName, string>> = {
  review: 'CODEX_MODEL',
  bugbot_triage: 'BUGBOT_MODEL',
};

export function resolvePhaseRoute(
  phase: PhaseName,
  profile: { phases?: Partial<Record<PhaseName, PhaseRoute>> } | undefined,
  registry: Record<string, ProviderCapability> = PROVIDER_REGISTRY,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPhaseRoute {
  const prefix = PHASE_ENV_PREFIX[phase];
  const profileRoute = profile?.phases?.[phase];

  // 1. Provider
  let provider: string;
  let providerSource: 'profile' | 'env' | 'default';
  if (profileRoute?.provider) { provider = profileRoute.provider; providerSource = 'profile'; }
  else if (env[`${prefix}_PROVIDER`]) { provider = env[`${prefix}_PROVIDER`]!; providerSource = 'env'; }
  else { provider = defaultPhaseProvider(phase); providerSource = 'default'; }

  const cap = registry[provider];
  if (!cap) {
    throw new GuardrailError(`Unknown provider "${provider}" for phase "${phase}"`, {
      code: 'invalid_config',
      details: { phase, provider, knownProviders: Object.keys(registry) },
    });
  }
  if (!cap.installed) {
    throw new GuardrailError(
      `Provider "${provider}" selected for phase "${phase}" but its SDK is not installed`,
      { code: 'auth', provider, details: { phase, hint: `Install the optional dependency for ${provider}` } },
    );
  }

  // 2. Model
  let model: string;
  let modelSource: 'profile' | 'env' | 'legacy-env' | 'default';
  const legacyEnvName = LEGACY_MODEL_ENV[phase];
  if (profileRoute?.model) { model = profileRoute.model; modelSource = 'profile'; }
  else if (env[`${prefix}_MODEL`]) { model = env[`${prefix}_MODEL`]!; modelSource = 'env'; }
  else if (legacyEnvName && env[legacyEnvName]) { model = env[legacyEnvName]!; modelSource = 'legacy-env'; }
  else {
    const defaultModel = cap.defaultModelByPhase[phase];
    if (!defaultModel) {
      throw new GuardrailError(
        `Provider "${provider}" has no default model for phase "${phase}"`,
        { code: 'invalid_config', details: { phase, provider } },
      );
    }
    model = defaultModel; modelSource = 'default';
  }

  // 3. baseUrl
  let baseUrl: string | undefined;
  let baseUrlSource: 'profile' | 'env' | undefined;
  if (profileRoute?.baseUrl) { baseUrl = profileRoute.baseUrl; baseUrlSource = 'profile'; }
  else if (env[`${prefix}_BASE_URL`]) { baseUrl = env[`${prefix}_BASE_URL`]; baseUrlSource = 'env'; }

  if (baseUrl && !cap.supportsBaseUrl) {
    console.warn(
      `[cadence] phase=${phase} provider=${provider} does not support custom baseUrl — ignoring "${baseUrl}"`,
    );
    baseUrl = undefined;
    baseUrlSource = undefined;
  }

  return {
    provider,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    sources: {
      provider: providerSource,
      model: modelSource,
      ...(baseUrlSource ? { baseUrl: baseUrlSource } : {}),
    },
  };
}
```

**Tests**: `tests/phases/resolve-phase-route.test.ts` — 7 tests per spec §Testing items 1-7.

```typescript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePhaseRoute } from '../../src/core/phases/resolve-phase-route.ts';
import { PROVIDER_REGISTRY } from '../../src/core/phases/provider-registry.ts';

// Use a frozen mini-registry so installed=true regardless of test machine.
const REG = {
  openai:    { id: 'openai',    installed: true, supportsBaseUrl: true,  defaultModelByPhase: { review: 'gpt-5.5',         council: 'gpt-5.5',         bugbot_triage: 'gpt-5.5' } },
  anthropic: { id: 'anthropic', installed: true, supportsBaseUrl: false, defaultModelByPhase: { review: 'claude-opus-4-7', council: 'claude-opus-4-7', bugbot_triage: 'claude-haiku-4-5' } },
  google:    { id: 'google',    installed: true, supportsBaseUrl: false, defaultModelByPhase: { review: 'gemini-2.5-pro-preview-05-06' } },
};

describe('resolvePhaseRoute', () => {
  it('profile entry overrides env var', () => {
    const r = resolvePhaseRoute('review', { phases: { review: { provider: 'anthropic', model: 'claude-x' } } }, REG, { REVIEW_PROVIDER: 'openai', REVIEW_MODEL: 'gpt-y' });
    assert.equal(r.provider, 'anthropic'); assert.equal(r.sources.provider, 'profile');
    assert.equal(r.model, 'claude-x'); assert.equal(r.sources.model, 'profile');
  });
  it('env var overrides default', () => {
    const r = resolvePhaseRoute('review', undefined, REG, { REVIEW_PROVIDER: 'anthropic', REVIEW_MODEL: 'claude-y' });
    assert.equal(r.provider, 'anthropic'); assert.equal(r.sources.provider, 'env');
    assert.equal(r.model, 'claude-y'); assert.equal(r.sources.model, 'env');
  });
  it('legacy CODEX_MODEL respected for review', () => {
    const r = resolvePhaseRoute('review', undefined, REG, { CODEX_MODEL: 'gpt-legacy' });
    assert.equal(r.provider, 'openai'); assert.equal(r.sources.provider, 'default');
    assert.equal(r.model, 'gpt-legacy'); assert.equal(r.sources.model, 'legacy-env');
  });
  it('unknown provider in profile rejected at resolve time', () => {
    assert.throws(
      () => resolvePhaseRoute('review', { phases: { review: { provider: 'bogus' } } }, REG, {}),
      /Unknown provider/,
    );
  });
  it('provider-only profile override falls back to registry default model', () => {
    const r = resolvePhaseRoute('review', { phases: { review: { provider: 'anthropic' } } }, REG, {});
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.model, 'claude-opus-4-7'); assert.equal(r.sources.model, 'default');
  });
  it('provider-only env override falls back to chosen providers default, not the default-provider default', () => {
    const r = resolvePhaseRoute('review', undefined, REG, { REVIEW_PROVIDER: 'anthropic' });
    assert.equal(r.provider, 'anthropic'); assert.equal(r.model, 'claude-opus-4-7');
    assert.equal(r.sources.model, 'default');
  });
  it('baseUrl on provider lacking baseUrl support is dropped with a warning', () => {
    const warns: unknown[] = [];
    const origWarn = console.warn;
    console.warn = (msg: unknown) => warns.push(msg);
    try {
      const r = resolvePhaseRoute('review', { phases: { review: { provider: 'anthropic', baseUrl: 'https://example.com' } } }, REG, {});
      assert.equal(r.baseUrl, undefined);
      assert.ok(warns.some(w => String(w).includes('does not support custom baseUrl')));
    } finally { console.warn = origWarn; }
  });
});
```

## Step 4 — Dispatcher (the load-bearing piece)

**File**: `src/core/phases/dispatch.ts` (new)

The dispatcher switches on `route.provider` and routes to the right adapter. It does NOT itself know about API keys, retries, or pricing — it's a thin switch + a single contract: every per-provider adapter is called with `(route, input)` and returns a `ReviewOutput`. Adapters read `route.model` / `route.baseUrl` via the existing `input.context` channel (gemini and claude already do this — codex needs the same change in Step 5).

```typescript
import type { ReviewInput, ReviewOutput, ReviewEngine } from '../../adapters/review-engine/types.ts';
import type { ResolvedPhaseRoute } from './resolve-phase-route.ts';
import { GuardrailError } from '../errors.ts';

export class UnsupportedProviderError extends GuardrailError {
  constructor(provider: string, phase: string) {
    super(`Provider "${provider}" is not supported for phase "${phase}"`, {
      code: 'invalid_config',
      provider,
      details: { phase },
    });
    this.name = 'UnsupportedProviderError';
  }
}

// Adapter loaders are deliberately injected via getters so tests can swap them.
interface AdapterRegistry {
  loadReviewAdapter(provider: string): Promise<ReviewEngine>;
}

const DEFAULT_REGISTRY: AdapterRegistry = {
  async loadReviewAdapter(provider: string): Promise<ReviewEngine> {
    switch (provider) {
      case 'openai':            return (await import('../../adapters/review-engine/codex.ts')).codexAdapter;
      case 'anthropic':         return (await import('../../adapters/review-engine/claude.ts')).claudeAdapter;
      case 'google':            return (await import('../../adapters/review-engine/gemini.ts')).geminiAdapter;
      case 'bedrock':           return (await import('../../adapters/review-engine/bedrock.ts')).bedrockAdapter;
      case 'azure':             return (await import('../../adapters/review-engine/azure.ts')).azureAdapter;
      case 'cohere':            return (await import('../../adapters/review-engine/cohere.ts')).cohereAdapter;
      case 'mistral':           return (await import('../../adapters/review-engine/mistral.ts')).mistralAdapter;
      case 'groq':
      case 'ollama':
      case 'deepseek':
      case 'together':
      case 'fireworks':
      case 'perplexity':
      case 'openrouter':
      case 'xai':
      case 'openai-compatible': return (await import('../../adapters/review-engine/openai-compatible.ts')).openaiCompatibleAdapter;
      default: throw new UnsupportedProviderError(provider, 'review');
    }
  },
};

let _registry: AdapterRegistry = DEFAULT_REGISTRY;

/** @internal test seam — pass null to restore default. */
export function __setAdapterRegistry(reg: AdapterRegistry | null): void {
  _registry = reg ?? DEFAULT_REGISTRY;
}

function withRoute(input: ReviewInput, route: ResolvedPhaseRoute): ReviewInput {
  return {
    ...input,
    context: {
      ...(input.context ?? {}),
      model: route.model,
      ...(route.baseUrl ? { baseUrl: route.baseUrl } : {}),
    } as ReviewInput['context'],
  };
}

export async function invokeReview(route: ResolvedPhaseRoute, input: ReviewInput): Promise<ReviewOutput> {
  const adapter = await _registry.loadReviewAdapter(route.provider);
  return adapter.review(withRoute(input, route));
}

export async function invokeCouncil(route: ResolvedPhaseRoute, input: ReviewInput): Promise<ReviewOutput> {
  // Council shares the review-engine contract today (one model, one prompt).
  // When council pool composition lands as a follow-up, this entry point
  // will evolve to fan out across multiple adapters.
  const adapter = await _registry.loadReviewAdapter(route.provider);
  return adapter.review(withRoute(input, route));
}

export async function invokeBugbotTriage(route: ResolvedPhaseRoute, input: ReviewInput): Promise<ReviewOutput> {
  const adapter = await _registry.loadReviewAdapter(route.provider);
  return adapter.review(withRoute(input, route));
}
```

**Tests**: `tests/phases/dispatch.test.ts` — the load-bearing 4 tests. Use the `__setAdapterRegistry` seam to inject fakes; no real network call.

```typescript
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  invokeReview, invokeCouncil, invokeBugbotTriage,
  __setAdapterRegistry, UnsupportedProviderError,
} from '../../src/core/phases/dispatch.ts';
import type { ReviewEngine } from '../../src/adapters/review-engine/types.ts';

function makeFakeAdapter(name: string): { adapter: ReviewEngine; lastInput: any } {
  const state: { lastInput: any } = { lastInput: null };
  const adapter: ReviewEngine = {
    name, apiVersion: '1.0.0',
    getCapabilities() { return { structuredOutput: false, streaming: false, maxContextTokens: 1000, inlineComments: false }; },
    estimateTokens(c) { return c.length; },
    async review(input) {
      state.lastInput = input;
      return { findings: [], rawOutput: `from-${name}` };
    },
  };
  return { adapter, lastInput: state.lastInput };
}

afterEach(() => __setAdapterRegistry(null));

describe('dispatch', () => {
  it('invokeReview with anthropic calls claude adapter, not codex', async () => {
    const calls: string[] = [];
    __setAdapterRegistry({
      async loadReviewAdapter(p) {
        calls.push(p);
        const { adapter } = makeFakeAdapter(p);
        return adapter;
      },
    });
    const out = await invokeReview(
      { provider: 'anthropic', model: 'claude-opus-4-7', sources: { provider: 'profile', model: 'default' } },
      { content: 'x', kind: 'spec' },
    );
    assert.deepEqual(calls, ['anthropic']);
    assert.equal(out.rawOutput, 'from-anthropic');
  });

  it('invokeCouncil with google calls the gemini adapter', async () => {
    const calls: string[] = [];
    __setAdapterRegistry({
      async loadReviewAdapter(p) {
        calls.push(p);
        const { adapter } = makeFakeAdapter(p);
        return adapter;
      },
    });
    await invokeCouncil(
      { provider: 'google', model: 'gemini-2.5-pro-preview-05-06', sources: { provider: 'profile', model: 'default' } },
      { content: 'x', kind: 'spec' },
    );
    assert.deepEqual(calls, ['google']);
  });

  it('invokeBugbotTriage with openai calls the codex/openai adapter', async () => {
    const calls: string[] = [];
    __setAdapterRegistry({
      async loadReviewAdapter(p) {
        calls.push(p);
        const { adapter } = makeFakeAdapter(p);
        return adapter;
      },
    });
    await invokeBugbotTriage(
      { provider: 'openai', model: 'gpt-5.5', sources: { provider: 'profile', model: 'default' } },
      { content: 'x', kind: 'pr-diff' },
    );
    assert.deepEqual(calls, ['openai']);
  });

  it('unsupported provider throws UnsupportedProviderError before any network call', async () => {
    __setAdapterRegistry({
      async loadReviewAdapter(p) {
        if (p === 'nonsense') throw new UnsupportedProviderError(p, 'review');
        throw new Error('should not reach');
      },
    });
    await assert.rejects(
      () => invokeReview(
        { provider: 'nonsense', model: 'x', sources: { provider: 'profile', model: 'default' } },
        { content: 'x', kind: 'spec' },
      ),
      (err: Error) => err instanceof UnsupportedProviderError,
    );
  });
});
```

## Step 5 — Adapter refactor (minimal touch)

Goal: stop hardcoding the model at module-load time. Instead, the dispatcher always passes `route.model` via `input.context.model`.

**`src/adapters/review-engine/codex.ts`** — change:

```typescript
// Before
const DEFAULT_MODEL = process.env.CODEX_MODEL ?? 'gpt-5.5';
...
response = await client.responses.create({ model: DEFAULT_MODEL, ... });

// After
const FALLBACK_MODEL = 'gpt-5.5';
...
async review(input: ReviewInput): Promise<ReviewOutput> {
  ...
  const model = (input.context as Record<string, unknown> | undefined)?.['model'] as string | undefined
    ?? process.env.CODEX_MODEL ?? FALLBACK_MODEL;
  response = await client.responses.create({ model, ... });
}
```

Then keep `_pricing = getModelPricing(FALLBACK_MODEL)` — pricing fallbacks are dispatcher-agnostic.

**`src/adapters/review-engine/claude.ts`** — already reads `input.context.model`; just rename `DEFAULT_MODEL` → `FALLBACK_MODEL` and document that dispatcher passes the resolved value.

**`src/adapters/review-engine/gemini.ts`** — same as claude.

**No other adapters** (bedrock, azure, cohere, mistral, openai-compatible) change in this PR — they're not the spec's focus and they already accept `context.model` via various paths.

**Existing tests stay green**: `claude-adapter.test.ts` and similar only assert that `estimateTokens` works and `ANTHROPIC_API_KEY` missing throws — they don't depend on the constant name.

## Step 6 — `cadence routes` CLI verb

**File**: `src/cli/routes.ts` (new)

```typescript
/**
 * `cadence routes` — print the resolved provider+model+baseUrl for each
 * routed phase, with per-field source attribution. Read-only.
 */
import { resolveProfile } from '../core/profile/resolver.ts';
import { resolvePhaseRoute, type ResolvedPhaseRoute } from '../core/phases/resolve-phase-route.ts';
import type { PhaseName } from '../core/phases/provider-registry.ts';

const PHASES: PhaseName[] = ['review', 'council', 'bugbot_triage'];

export interface RoutesOptions { cwd: string; flagProfile?: string; }

function fmt(phase: string, r: ResolvedPhaseRoute): string {
  const sources = [
    `provider: ${r.sources.provider}`,
    `model: ${r.sources.model}`,
    ...(r.sources.baseUrl ? [`baseUrl: ${r.sources.baseUrl}`] : []),
  ].join(', ');
  return `${phase.padEnd(15)}${r.provider} / ${r.model}${r.baseUrl ? ` @ ${r.baseUrl}` : ''}   (${sources})`;
}

export async function runRoutesCommand(opts: RoutesOptions): Promise<number> {
  const resolved = resolveProfile({
    cwd: opts.cwd,
    ...(opts.flagProfile !== undefined ? { flagProfile: opts.flagProfile } : {}),
  });
  console.log(`Profile: ${resolved.name} (source: ${resolved.source})`);
  console.log('');
  console.log(`${'implement'.padEnd(15)}runtime-bound (Claude Code session model)`);
  for (const phase of PHASES) {
    try {
      const route = resolvePhaseRoute(phase, resolved.config as any);
      console.log(fmt(phase, route));
    } catch (err) {
      console.log(`${phase.padEnd(15)}<unresolved: ${(err as Error).message}>`);
    }
  }
  return 0;
}
```

**Wire into `src/cli/index.ts`** — add a new case before `case 'runs':`:

```typescript
case 'routes': {
  const { runRoutesCommand } = await import('./routes.ts');
  const code = await runRoutesCommand({
    cwd: process.cwd(),
    ...(globalProfileFlag !== undefined ? { flagProfile: globalProfileFlag } : {}),
  });
  process.exit(code);
  break;
}
```

**Test**: `tests/cli/routes.test.ts` — spawn the CLI, assert output contains `implement` line + 3 phase lines:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = path.join(ROOT, 'src', 'cli', 'index.ts');
const TSX_LOADER = pathToFileURL(path.join(ROOT, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href;

describe('cadence routes', () => {
  it('prints implement as runtime-bound and lists 3 routed phases with source attribution', () => {
    const r = spawnSync(process.execPath, ['--import', TSX_LOADER, ENTRY, 'routes'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_AUTOPILOT_PROFILE: 'solo' },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /implement\s+runtime-bound/);
    assert.match(r.stdout, /review\s+\S+\s*\/\s*\S+\s+\(provider: \w+, model: \w+/);
    assert.match(r.stdout, /council\s+\S+\s*\/\s*\S+\s+\(provider: \w+, model: \w+/);
    assert.match(r.stdout, /bugbot_triage\s+\S+\s*\/\s*\S+\s+\(provider: \w+, model: \w+/);
  });
});
```

## Step 7 — Profile YAML examples

Append to `presets/profiles/oss-maintainer.yaml`:

```yaml
# Optional: per-phase provider routing override (v8.5.0+).
# Uncomment to pin a phase to a specific provider+model. Precedence:
# profile > env var > adapter default. The `implement` phase is intentionally
# absent — Claude Code's session model is not overridable from outside.
#
# phases:
#   review:        { provider: openai,    model: gpt-5.5 }
#   council:       { provider: google,    model: gemini-2.5-pro-preview-05-06 }
#   bugbot_triage: { provider: anthropic, model: claude-haiku-4-5 }
```

Same comment block appended to `enterprise.yaml`. `solo.yaml` is left minimal.

## Step 8 — README

Append a "Provider routing" section after the existing "Configuration" section pointing at `cadence routes` and the YAML override.

## Step 9 — Validate + ship

```bash
npm run build && npm test
```

If anything red, fix in place; the dispatcher tests are the canary — if they pass, the architecture is right.

## Out of scope (defer)

- Council pool composition (multi-advisor + synthesizer with independent routes).
- `implement` phase routing (needs Claude Code runtime-config hook).
- baseUrl allowlist for high-sensitivity deployments (codex NOTE).
- Bugbot script profile-propagation flag (codex NOTE — formalize in follow-up).
