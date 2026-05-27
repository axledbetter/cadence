/**
 * Phase routing — pure resolver.
 *
 * Given a phase name, an optional profile, and an env, returns a fully-
 * materialized route with per-field source attribution. Does NOT check
 * SDK installation (that's a runtime concern handled by `dispatch.ts`).
 *
 * Per-field precedence (provider resolved first, then model + baseUrl
 * relative to the chosen provider):
 *
 *   provider:  profile.phases[phase].provider
 *           → env[<PHASE>_PROVIDER]
 *           → defaultPhaseProvider(phase)
 *
 *   model:     profile.phases[phase].model
 *           → env[<PHASE>_MODEL]
 *           → legacy env (CODEX_MODEL for review, BUGBOT_MODEL for bugbot_triage)
 *           → registry[provider].defaultModelByPhase[phase]
 *
 *   baseUrl:   profile.phases[phase].baseUrl
 *           → env[<PHASE>_BASE_URL]
 *           → registry[provider].defaultBaseUrl
 *           → undefined
 *
 * Per-field precedence is intentional: a user may pin `provider:
 * anthropic` in YAML and still want `REVIEW_MODEL=claude-other` to win
 * via env without editing the file. The resolver tests cover this
 * specifically.
 */
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
  /** Env var name that the adapter should read for the API key. */
  apiKeyEnv: string;
  /** Whether the provider supports a non-default baseUrl. */
  supportsBaseUrl: boolean;
  /** Whether the provider's optional SDK is currently installed. */
  installed: boolean;
  sources: {
    provider: 'profile' | 'env' | 'default';
    model: 'profile' | 'env' | 'legacy-env' | 'default';
    baseUrl?: 'profile' | 'env' | 'default';
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

export interface ProfileWithPhases {
  phases?: Partial<Record<PhaseName, PhaseRoute>>;
}

// Block IP literals/hostnames that could let a malicious profile point the
// SDK at an attacker-controlled or metadata-service endpoint while still
// sending the API key (codex CRITICAL — profile-controlled baseUrl
// exfiltration). Loopback, link-local, RFC1918, AWS/GCP metadata.
const BLOCKED_HOSTS = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  '169.254.169.254',  // AWS/GCP/Azure metadata
  'metadata.google.internal',
]);
const PRIVATE_IP_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fc|fd|fe80:)/i;

function validateBaseUrl(raw: string, source: 'profile' | 'env'): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GuardrailError(
      `Invalid baseUrl from ${source}: "${raw}"`,
      { code: 'invalid_config', details: { source, value: raw } },
    );
  }
  // Require https. http would let a MITM swap the target or read API keys
  // in plaintext. The single legitimate exception (local mock servers in
  // tests) is handled by passing baseUrl directly to the adapter in test
  // code, not by config resolution.
  if (url.protocol !== 'https:') {
    throw new GuardrailError(
      `Insecure baseUrl from ${source}: "${raw}" — only https:// is allowed for provider endpoints`,
      { code: 'invalid_config', details: { source, value: raw, protocol: url.protocol } },
    );
  }
  // Reject hosts that would expose cloud-instance metadata or loop back to
  // the local machine — a profile-supplied baseUrl pointing at
  // 169.254.169.254 with the OpenAI SDK would happily POST the bearer
  // token there. URL.hostname keeps IPv6 literals bracketed (`[::1]`), so
  // normalize before lookup.
  const host = url.hostname.toLowerCase().replace(/^\[(.+)\]$/, '$1');
  if (BLOCKED_HOSTS.has(host) || PRIVATE_IP_RE.test(host)) {
    throw new GuardrailError(
      `Disallowed baseUrl host from ${source}: "${host}" — private, loopback, link-local, and cloud-metadata addresses are blocked`,
      { code: 'invalid_config', details: { source, value: raw, host } },
    );
  }
  return raw;
}

export function resolvePhaseRoute(
  phase: PhaseName,
  profile: ProfileWithPhases | undefined,
  registry: Record<string, ProviderCapability> = PROVIDER_REGISTRY,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPhaseRoute {
  const prefix = PHASE_ENV_PREFIX[phase];
  const profileRoute = profile?.phases?.[phase];

  // 1. Provider
  let provider: string;
  let providerSource: 'profile' | 'env' | 'default';
  if (profileRoute?.provider) {
    provider = profileRoute.provider;
    providerSource = 'profile';
  } else if (env[`${prefix}_PROVIDER`]) {
    provider = env[`${prefix}_PROVIDER`]!;
    providerSource = 'env';
  } else {
    provider = defaultPhaseProvider(phase);
    providerSource = 'default';
  }

  const cap = registry[provider];
  if (!cap) {
    throw new GuardrailError(`Unknown provider "${provider}" for phase "${phase}"`, {
      code: 'invalid_config',
      details: { phase, provider, knownProviders: Object.keys(registry) },
    });
  }

  // 2. Model
  let model: string;
  let modelSource: 'profile' | 'env' | 'legacy-env' | 'default';
  const legacyEnvName = LEGACY_MODEL_ENV[phase];
  if (profileRoute?.model) {
    model = profileRoute.model;
    modelSource = 'profile';
  } else if (env[`${prefix}_MODEL`]) {
    model = env[`${prefix}_MODEL`]!;
    modelSource = 'env';
  } else if (legacyEnvName && env[legacyEnvName]) {
    model = env[legacyEnvName]!;
    modelSource = 'legacy-env';
  } else {
    const defaultModel = cap.defaultModelByPhase[phase];
    if (!defaultModel) {
      throw new GuardrailError(
        `Provider "${provider}" has no default model for phase "${phase}"`,
        { code: 'invalid_config', details: { phase, provider } },
      );
    }
    model = defaultModel;
    modelSource = 'default';
  }

  // 3. baseUrl
  let baseUrl: string | undefined;
  let baseUrlSource: 'profile' | 'env' | 'default' | undefined;
  if (profileRoute?.baseUrl) {
    baseUrl = validateBaseUrl(profileRoute.baseUrl, 'profile');
    baseUrlSource = 'profile';
  } else if (env[`${prefix}_BASE_URL`]) {
    baseUrl = validateBaseUrl(env[`${prefix}_BASE_URL`]!, 'env');
    baseUrlSource = 'env';
  } else if (cap.defaultBaseUrl) {
    baseUrl = cap.defaultBaseUrl;
    baseUrlSource = 'default';
  }

  if (baseUrl && !cap.supportsBaseUrl) {
    // Profile or env explicitly set a baseUrl on a provider that ignores
    // it. The registry-default case is also dropped (registry shouldn't
    // ship a defaultBaseUrl for an unsupported provider, but be safe).
    if (baseUrlSource !== 'default') {
      console.warn(
        `[cadence] phase=${phase} provider=${provider} does not support custom baseUrl — ignoring "${baseUrl}"`,
      );
    }
    baseUrl = undefined;
    baseUrlSource = undefined;
  }

  return {
    provider,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    apiKeyEnv: cap.apiKeyEnv,
    supportsBaseUrl: cap.supportsBaseUrl,
    installed: cap.installed,
    sources: {
      provider: providerSource,
      model: modelSource,
      ...(baseUrlSource ? { baseUrl: baseUrlSource } : {}),
    },
  };
}
