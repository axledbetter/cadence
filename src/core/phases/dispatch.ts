/**
 * Phase routing — dispatcher.
 *
 * Switches on `route.provider` and forwards the resolved
 * (provider, model, baseUrl, apiKeyEnv) to the right adapter via
 * `input.context`. Provider-specific adapters never inspect the route —
 * they just consume `context.model` / `context.baseUrl` /
 * `context.apiKeyEnv`.
 *
 * The dispatcher is the load-bearing piece per the spec — it's what makes
 * `phases:` in profile YAML actually re-route runtime calls. Adapter
 * `DEFAULT_MODEL` constants are removed in Step 5 so adapters always
 * receive the resolved model from here.
 *
 * Installation is verified here (not in the resolver), so
 * `cadence routes` can show install state without throwing.
 */
import type { ReviewInput, ReviewOutput, ReviewEngine } from '../../adapters/review-engine/types.ts';
import type { ResolvedPhaseRoute } from './resolve-phase-route.ts';
import type { PhaseName } from './provider-registry.ts';
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

export interface AdapterRegistry {
  loadReviewAdapter(provider: string, phase: PhaseName): Promise<ReviewEngine>;
}

const DEFAULT_REGISTRY: AdapterRegistry = {
  async loadReviewAdapter(provider: string, phase: PhaseName): Promise<ReviewEngine> {
    switch (provider) {
      case 'openai':
        return (await import('../../adapters/review-engine/codex.ts')).codexAdapter;
      case 'anthropic':
        return (await import('../../adapters/review-engine/claude.ts')).claudeAdapter;
      case 'google':
        return (await import('../../adapters/review-engine/gemini.ts')).geminiAdapter;
      case 'bedrock':
        return (await import('../../adapters/review-engine/bedrock.ts')).bedrockAdapter;
      case 'azure':
        return (await import('../../adapters/review-engine/azure.ts')).azureAdapter;
      case 'cohere':
        return (await import('../../adapters/review-engine/cohere.ts')).cohereAdapter;
      case 'mistral':
        return (await import('../../adapters/review-engine/mistral.ts')).mistralAdapter;
      case 'openai-compatible':
        return (await import('../../adapters/review-engine/openai-compatible.ts')).openaiCompatibleAdapter;
      default:
        throw new UnsupportedProviderError(provider, phase);
    }
  },
};

let _registry: AdapterRegistry = DEFAULT_REGISTRY;

/** @internal test seam — pass null to restore default. */
export function __setAdapterRegistry(reg: AdapterRegistry | null): void {
  _registry = reg ?? DEFAULT_REGISTRY;
}

function assertInstalled(route: ResolvedPhaseRoute, phase: PhaseName): void {
  if (!route.installed) {
    throw new GuardrailError(
      `Provider "${route.provider}" selected for phase "${phase}" but its SDK is not installed`,
      {
        code: 'auth',
        provider: route.provider,
        details: { phase, hint: `Install the optional dependency for ${route.provider}` },
      },
    );
  }
}

function withRoute(input: ReviewInput, route: ResolvedPhaseRoute): ReviewInput {
  return {
    ...input,
    context: {
      ...(input.context ?? {}),
      provider: route.provider,
      model: route.model,
      apiKeyEnv: route.apiKeyEnv,
      ...(route.baseUrl ? { baseUrl: route.baseUrl } : {}),
    } as ReviewInput['context'],
  };
}

async function invoke(
  phase: PhaseName,
  route: ResolvedPhaseRoute,
  input: ReviewInput,
): Promise<ReviewOutput> {
  assertInstalled(route, phase);
  const adapter = await _registry.loadReviewAdapter(route.provider, phase);
  return adapter.review(withRoute(input, route));
}

export function invokeReview(route: ResolvedPhaseRoute, input: ReviewInput): Promise<ReviewOutput> {
  return invoke('review', route, input);
}

export function invokeCouncil(route: ResolvedPhaseRoute, input: ReviewInput): Promise<ReviewOutput> {
  // Council shares the review-engine contract today (one model, one prompt).
  // When council pool composition lands as a follow-up, this entry point
  // will evolve to fan out across multiple adapters.
  return invoke('council', route, input);
}

export function invokeBugbotTriage(
  route: ResolvedPhaseRoute,
  input: ReviewInput,
): Promise<ReviewOutput> {
  return invoke('bugbot_triage', route, input);
}
