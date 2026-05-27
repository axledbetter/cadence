/**
 * Dispatcher unit tests — the load-bearing piece per spec.
 *
 * These tests are what prove "phases: { review: { provider: anthropic } }"
 * in profile YAML actually routes to the Claude adapter (not codex).
 *
 * Uses `__setAdapterRegistry` to inject a recording fake adapter so no
 * network calls fire. Covers spec §Testing items 8-11.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  invokeReview,
  invokeCouncil,
  invokeBugbotTriage,
  __setAdapterRegistry,
  UnsupportedProviderError,
} from '../../src/core/phases/dispatch.ts';
import type { ReviewEngine, ReviewInput } from '../../src/adapters/review-engine/types.ts';
import type { ResolvedPhaseRoute } from '../../src/core/phases/resolve-phase-route.ts';

interface FakeState {
  lastProvider: string | null;
  lastInput: ReviewInput | null;
}

function makeFakeAdapter(name: string, state: FakeState): ReviewEngine {
  return {
    name,
    apiVersion: '1.0.0',
    getCapabilities() {
      return {
        structuredOutput: false,
        streaming: false,
        maxContextTokens: 1000,
        inlineComments: false,
      };
    },
    estimateTokens(c: string) {
      return c.length;
    },
    async review(input: ReviewInput) {
      state.lastInput = input;
      return { findings: [], rawOutput: `from-${name}` };
    },
  };
}

function route(provider: string, model: string, baseUrl?: string): ResolvedPhaseRoute {
  return {
    provider,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    apiKeyEnv: 'TEST_KEY',
    supportsBaseUrl: true,
    installed: true,
    sources: { provider: 'profile', model: 'default', ...(baseUrl ? { baseUrl: 'profile' as const } : {}) },
  };
}

afterEach(() => __setAdapterRegistry(null));

describe('dispatch', () => {
  it('#8: invokeReview with provider=anthropic calls the Claude adapter, NOT codex', async () => {
    const state: FakeState = { lastProvider: null, lastInput: null };
    __setAdapterRegistry({
      async loadReviewAdapter(p) {
        state.lastProvider = p;
        return makeFakeAdapter(p, state);
      },
    });
    const out = await invokeReview(
      route('anthropic', 'claude-opus-4-7'),
      { content: 'x', kind: 'spec' },
    );
    assert.equal(state.lastProvider, 'anthropic');
    assert.equal(out.rawOutput, 'from-anthropic');
    // Context propagation check — provider/model/apiKeyEnv must be set.
    assert.equal(state.lastInput?.context?.provider, 'anthropic');
    assert.equal(state.lastInput?.context?.model, 'claude-opus-4-7');
    assert.equal(state.lastInput?.context?.apiKeyEnv, 'TEST_KEY');
  });

  it('#9: invokeCouncil with provider=google calls the Gemini adapter', async () => {
    const state: FakeState = { lastProvider: null, lastInput: null };
    __setAdapterRegistry({
      async loadReviewAdapter(p) {
        state.lastProvider = p;
        return makeFakeAdapter(p, state);
      },
    });
    await invokeCouncil(
      route('google', 'gemini-2.5-pro-preview-05-06'),
      { content: 'x', kind: 'spec' },
    );
    assert.equal(state.lastProvider, 'google');
  });

  it('#10: invokeBugbotTriage with provider=openai calls the OpenAI adapter', async () => {
    const state: FakeState = { lastProvider: null, lastInput: null };
    __setAdapterRegistry({
      async loadReviewAdapter(p) {
        state.lastProvider = p;
        return makeFakeAdapter(p, state);
      },
    });
    await invokeBugbotTriage(
      route('openai', 'gpt-5.5'),
      { content: 'x', kind: 'pr-diff' },
    );
    assert.equal(state.lastProvider, 'openai');
  });

  it('#11: unsupported provider throws UnsupportedProviderError BEFORE any network call (and reports the right phase)', async () => {
    __setAdapterRegistry({
      async loadReviewAdapter(p, phase) {
        if (p === 'nonsense-provider') throw new UnsupportedProviderError(p, phase);
        throw new Error('should not reach');
      },
    });
    await assert.rejects(
      () =>
        invokeCouncil(route('nonsense-provider', 'x'), { content: 'x', kind: 'spec' }),
      (err: Error) => {
        if (!(err instanceof UnsupportedProviderError)) return false;
        // Phase must be reported as 'council', not 'review'.
        return /council/.test(err.message);
      },
    );
  });

  it('baseUrl from the route is propagated to input.context.baseUrl', async () => {
    const state: FakeState = { lastProvider: null, lastInput: null };
    __setAdapterRegistry({
      async loadReviewAdapter(p) {
        return makeFakeAdapter(p, state);
      },
    });
    await invokeReview(
      route('openai-compatible', 'llama-3', 'https://api.groq.com/openai/v1'),
      { content: 'x', kind: 'spec' },
    );
    assert.equal(state.lastInput?.context?.baseUrl, 'https://api.groq.com/openai/v1');
  });

  it('uninstalled provider throws GuardrailError at invocation (resolver does NOT pre-check)', async () => {
    __setAdapterRegistry({
      async loadReviewAdapter() {
        throw new Error('should not reach — assertInstalled fires first');
      },
    });
    const uninstalledRoute: ResolvedPhaseRoute = {
      ...route('cohere', 'command-r'),
      installed: false,
    };
    await assert.rejects(
      () => invokeReview(uninstalledRoute, { content: 'x', kind: 'spec' }),
      /SDK is not installed/,
    );
  });
});
