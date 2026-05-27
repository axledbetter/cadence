/**
 * Phase routing — provider registry.
 *
 * Single source of truth for what providers exist, what their default
 * model is per phase, whether they support a custom baseUrl, what env
 * var carries their API key, and whether the optional SDK is installed.
 *
 * Consumed by:
 *   - `resolvePhaseRoute()` — to fill in defaults and to attach
 *     `defaultBaseUrl` / `apiKeyEnv` to the resolved route.
 *   - `dispatch.ts` — to assert the provider's SDK is installed at
 *     invocation time (resolver is pure).
 *   - `cadence routes` — to display install status as metadata.
 *
 * Provider set: the 8 providers with first-party adapters under
 * `src/adapters/review-engine/`. Groq, Ollama, DeepSeek, Together,
 * Fireworks, Perplexity, OpenRouter, and xAI are reachable via the
 * `openai-compatible` bucket — users pin `provider: openai-compatible`
 * + an explicit `baseUrl` + the `apiKeyEnv` of their choice (see the
 * env-driven `buildGroqAdapter` pattern in `auto.ts`).
 *
 * Drift guard: `tests/phases/schema-registry-dispatch-parity.test.ts`
 * asserts the JSON Schema enum, this object's keys, and the
 * `dispatch.ts` switch cases stay in lock-step.
 */
import { createRequire } from 'node:module';

export type PhaseName = 'review' | 'council' | 'bugbot_triage';

export interface ProviderCapability {
  id: string;
  installed: boolean;
  supportsBaseUrl: boolean;
  /** Default API endpoint, if the provider exposes one and the adapter respects it. */
  defaultBaseUrl?: string;
  /** Env var the adapter reads for the API key. */
  apiKeyEnv: string;
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
    defaultBaseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultModelByPhase: { review: 'gpt-5.5', council: 'gpt-5.5', bugbot_triage: 'gpt-5.5' },
  },
  anthropic: {
    id: 'anthropic',
    installed: hasModule('@anthropic-ai/sdk'),
    supportsBaseUrl: false,
    apiKeyEnv: 'ANTHROPIC_API_KEY',
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
    apiKeyEnv: 'GEMINI_API_KEY',
    defaultModelByPhase: {
      review: 'gemini-2.5-pro-preview-05-06',
      council: 'gemini-2.5-pro-preview-05-06',
      bugbot_triage: 'gemini-2.5-flash',
    },
  },
  bedrock: {
    id: 'bedrock',
    installed: hasModule('@aws-sdk/client-bedrock-runtime'),
    supportsBaseUrl: false,
    apiKeyEnv: 'AWS_ACCESS_KEY_ID',
    defaultModelByPhase: {
      review: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      council: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      bugbot_triage: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    },
  },
  azure: {
    id: 'azure',
    installed: hasModule('openai'),
    supportsBaseUrl: true,
    apiKeyEnv: 'AZURE_OPENAI_API_KEY',
    defaultModelByPhase: { review: 'gpt-5.5', council: 'gpt-5.5', bugbot_triage: 'gpt-5.5' },
  },
  cohere: {
    id: 'cohere',
    installed: hasModule('cohere-ai'),
    supportsBaseUrl: false,
    apiKeyEnv: 'COHERE_API_KEY',
    defaultModelByPhase: {
      review: 'command-r-plus',
      council: 'command-r-plus',
      bugbot_triage: 'command-r',
    },
  },
  mistral: {
    id: 'mistral',
    installed: hasModule('openai'),
    supportsBaseUrl: true,
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    defaultModelByPhase: {
      review: 'mistral-large-latest',
      council: 'mistral-large-latest',
      bugbot_triage: 'mistral-small-latest',
    },
  },
  'openai-compatible': {
    id: 'openai-compatible',
    installed: hasModule('openai'),
    supportsBaseUrl: true,
    // No default baseUrl — caller MUST supply one (or env), otherwise
    // the adapter calls the OpenAI API which is almost certainly not
    // what the user wanted when they picked `openai-compatible`.
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultModelByPhase: { review: 'gpt-5.5', council: 'gpt-5.5', bugbot_triage: 'gpt-5.5' },
  },
};

const DEFAULT_PROVIDER_BY_PHASE: Record<PhaseName, string> = {
  review: 'openai',
  council: 'google',
  bugbot_triage: 'anthropic',
};

export function defaultPhaseProvider(phase: PhaseName): string {
  return DEFAULT_PROVIDER_BY_PHASE[phase];
}

export const ROUTED_PHASES: readonly PhaseName[] = ['review', 'council', 'bugbot_triage'] as const;
