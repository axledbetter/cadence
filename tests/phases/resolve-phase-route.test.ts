/**
 * Resolver unit tests — pure function, no I/O. Uses a frozen mini-registry
 * so `installed: true` regardless of test machine state.
 *
 * Covers the 7 spec-mandated test cases (spec §Testing items 1-7).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePhaseRoute } from '../../src/core/phases/resolve-phase-route.ts';
import type { ProviderCapability } from '../../src/core/phases/provider-registry.ts';

const REG: Record<string, ProviderCapability> = {
  openai: {
    id: 'openai',
    installed: true,
    supportsBaseUrl: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultModelByPhase: { review: 'gpt-5.5', council: 'gpt-5.5', bugbot_triage: 'gpt-5.5' },
  },
  anthropic: {
    id: 'anthropic',
    installed: true,
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
    installed: true,
    supportsBaseUrl: false,
    apiKeyEnv: 'GEMINI_API_KEY',
    defaultModelByPhase: {
      review: 'gemini-2.5-pro-preview-05-06',
      council: 'gemini-2.5-pro-preview-05-06',
      bugbot_triage: 'gemini-2.5-flash',
    },
  },
};

describe('resolvePhaseRoute', () => {
  it('#1: profile entry overrides env var', () => {
    const r = resolvePhaseRoute(
      'review',
      { phases: { review: { provider: 'anthropic', model: 'claude-x' } } },
      REG,
      { REVIEW_PROVIDER: 'openai', REVIEW_MODEL: 'gpt-y' },
    );
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.sources.provider, 'profile');
    assert.equal(r.model, 'claude-x');
    assert.equal(r.sources.model, 'profile');
    assert.equal(r.apiKeyEnv, 'ANTHROPIC_API_KEY');
  });

  it('#2: env var overrides default', () => {
    const r = resolvePhaseRoute('review', undefined, REG, {
      REVIEW_PROVIDER: 'anthropic',
      REVIEW_MODEL: 'claude-y',
    });
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.sources.provider, 'env');
    assert.equal(r.model, 'claude-y');
    assert.equal(r.sources.model, 'env');
  });

  it('#3: legacy CODEX_MODEL still respected for review when no profile + no REVIEW_MODEL', () => {
    const r = resolvePhaseRoute('review', undefined, REG, { CODEX_MODEL: 'gpt-legacy' });
    assert.equal(r.provider, 'openai');
    assert.equal(r.sources.provider, 'default');
    assert.equal(r.model, 'gpt-legacy');
    assert.equal(r.sources.model, 'legacy-env');
  });

  it('#4: unknown provider in profile rejected at resolve time', () => {
    assert.throws(
      () =>
        resolvePhaseRoute(
          'review',
          { phases: { review: { provider: 'bogus-provider' } } },
          REG,
          {},
        ),
      /Unknown provider/,
    );
  });

  it('#5: provider-only profile override resolves model from registry default', () => {
    const r = resolvePhaseRoute(
      'review',
      { phases: { review: { provider: 'anthropic' } } },
      REG,
      {},
    );
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.sources.provider, 'profile');
    assert.equal(r.model, 'claude-opus-4-7');
    assert.equal(r.sources.model, 'default');
  });

  it('#6: provider-only env override falls back to that providers default, not the default-providers default', () => {
    const r = resolvePhaseRoute('review', undefined, REG, { REVIEW_PROVIDER: 'anthropic' });
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.model, 'claude-opus-4-7');
    assert.equal(r.sources.model, 'default');
  });

  it('#7: baseUrl on a provider lacking baseUrl support is dropped with a warning', () => {
    const warns: unknown[] = [];
    const origWarn = console.warn;
    console.warn = (msg: unknown) => warns.push(msg);
    try {
      const r = resolvePhaseRoute(
        'review',
        { phases: { review: { provider: 'anthropic', baseUrl: 'https://example.com' } } },
        REG,
        {},
      );
      assert.equal(r.baseUrl, undefined);
      assert.equal(r.sources.baseUrl, undefined);
      assert.ok(
        warns.some(w => String(w).includes('does not support custom baseUrl')),
        'expected warning about ignored baseUrl',
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it('bonus: registry default baseUrl flows through for providers that support it', () => {
    const r = resolvePhaseRoute('review', undefined, REG, {});
    assert.equal(r.provider, 'openai');
    assert.equal(r.baseUrl, 'https://api.openai.com/v1');
    assert.equal(r.sources.baseUrl, 'default');
  });

  it('bonus: env REVIEW_BASE_URL with garbage value throws validation error', () => {
    assert.throws(
      () => resolvePhaseRoute('review', undefined, REG, { REVIEW_BASE_URL: 'not a url' }),
      /Invalid baseUrl/,
    );
  });
});
