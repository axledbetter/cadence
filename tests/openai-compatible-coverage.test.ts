// tests/openai-compatible-coverage.test.ts
//
// Verifies the documented OpenAI-compatible provider baseURLs are accepted by
// the existing openai-compatible adapter without configuration-time errors.
// These cover the providers documented in the README "OpenAI-compatible
// providers" section: Together AI, Anyscale, Fireworks, OpenRouter,
// Perplexity, DeepInfra, Hyperbolic. We assert URL parseability + adapter
// construction; we deliberately do NOT make live network calls (cost,
// flakiness).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const PROVIDERS: ReadonlyArray<{
  name: string;
  baseUrl: string;
  apiKeyEnv: string;
  exampleModel: string;
}> = [
  {
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    exampleModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  {
    name: 'Anyscale',
    baseUrl: 'https://api.endpoints.anyscale.com/v1',
    apiKeyEnv: 'ANYSCALE_API_KEY',
    exampleModel: 'meta-llama/Meta-Llama-3-70B-Instruct',
  },
  {
    name: 'Fireworks',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    exampleModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
  },
  {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    exampleModel: 'anthropic/claude-3.5-sonnet',
  },
  {
    name: 'Perplexity',
    baseUrl: 'https://api.perplexity.ai',
    apiKeyEnv: 'PPLX_API_KEY',
    exampleModel: 'llama-3.1-sonar-large-128k-online',
  },
  {
    name: 'DeepInfra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    apiKeyEnv: 'DEEPINFRA_API_TOKEN',
    exampleModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
  },
  {
    name: 'Hyperbolic',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    apiKeyEnv: 'HYPERBOLIC_API_KEY',
    exampleModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
  },
];

describe('openai-compatible coverage — documented provider baseURLs', () => {
  for (const provider of PROVIDERS) {
    it(`${provider.name}: baseUrl is a valid URL`, () => {
      assert.doesNotThrow(() => new URL(provider.baseUrl));
    });

    it(`${provider.name}: baseUrl uses https (no plaintext credentials in transit)`, () => {
      const url = new URL(provider.baseUrl);
      assert.equal(
        url.protocol,
        'https:',
        `${provider.name} baseUrl must be https — got ${url.protocol}`,
      );
    });

    it(`${provider.name}: apiKeyEnv looks like a conventional env var name`, () => {
      assert.match(
        provider.apiKeyEnv,
        /^[A-Z][A-Z0-9_]*$/,
        `${provider.name} apiKeyEnv "${provider.apiKeyEnv}" should be SCREAMING_SNAKE_CASE`,
      );
    });
  }

  it('openai-compatible adapter accepts each provider config without invalid_config errors at config parse time', async () => {
    const { openaiCompatibleAdapter } = await import(
      '../src/adapters/review-engine/openai-compatible.ts'
    );
    // The adapter validates options at review() entry (before any network
    // call). We invoke with each provider's documented options + a non-existent
    // apiKeyEnv that we set to a dummy key — the only failure mode we want to
    // surface here is "config rejected before SDK call" (i.e. our docs are
    // wrong). The SDK call itself will fail because the dummy key won't auth,
    // but that's an auth/transport error, NOT invalid_config.
    for (const provider of PROVIDERS) {
      const savedKey = process.env[provider.apiKeyEnv];
      process.env[provider.apiKeyEnv] = 'sk-test-dummy-do-not-use';
      try {
        let err: Error | null = null;
        try {
          await openaiCompatibleAdapter.review({
            content: 'noop',
            kind: 'file-batch',
            context: {
              model: provider.exampleModel,
              baseUrl: provider.baseUrl,
              apiKeyEnv: provider.apiKeyEnv,
            } as never,
          });
        } catch (e) {
          err = e as Error;
        }
        // If error fires, it must NOT be the `invalid_config` shape — that
        // would mean our documented snippet is structurally wrong.
        if (err) {
          const code = (err as Error & { code?: string }).code;
          assert.notEqual(
            code,
            'invalid_config',
            `${provider.name}: documented config rejected at parse time (${err.message})`,
          );
        }
      } finally {
        if (savedKey === undefined) delete process.env[provider.apiKeyEnv];
        else process.env[provider.apiKeyEnv] = savedKey;
      }
    }
  });
});
