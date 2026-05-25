// tests/azure-adapter.test.ts
//
// Unit tests for the Azure OpenAI review adapter. Uses the adapter's
// `__setAzureSdkLoader` test seam to substitute a fake OpenAI SDK constructor
// that captures the deployment-routed baseURL + api-version + api-key
// headers without hitting Azure.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const ORIGINAL_ENV = {
  AZURE_OPENAI_API_KEY: process.env.AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_ENDPOINT: process.env.AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_DEPLOYMENT_NAME: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
  AZURE_OPENAI_API_VERSION: process.env.AZURE_OPENAI_API_VERSION,
};

function restoreEnv(): void {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

interface AzureCapture {
  baseURL?: string;
  defaultQuery?: Record<string, string>;
  defaultHeaders?: Record<string, string>;
  apiKey?: string;
  sentModel?: string;
  forceErrorStatus?: number;
}

function makeMockOpenAICtor(capture: AzureCapture, responseText: string) {
  class MockOpenAI {
    chat: {
      completions: {
        create: (args: { model: string; messages: unknown[] }) => Promise<unknown>;
      };
    };
    constructor(opts: {
      apiKey: string;
      baseURL?: string;
      defaultQuery?: Record<string, string>;
      defaultHeaders?: Record<string, string>;
    }) {
      capture.apiKey = opts.apiKey;
      capture.baseURL = opts.baseURL;
      capture.defaultQuery = opts.defaultQuery;
      capture.defaultHeaders = opts.defaultHeaders;
      this.chat = {
        completions: {
          create: async (args) => {
            capture.sentModel = args.model;
            if (capture.forceErrorStatus !== undefined) {
              const status = capture.forceErrorStatus;
              let msg = `HTTP ${status}`;
              if (status === 401 || status === 403)
                msg = `Authentication failed (${status})`;
              else if (status === 429) msg = `Too many requests — rate limit`;
              else if (status >= 500) msg = `network error`;
              throw new Error(msg);
            }
            return {
              choices: [{ message: { content: responseText } }],
              usage: { prompt_tokens: 11, completion_tokens: 22 },
            };
          },
        },
      };
    }
  }
  // Mirror the way real OpenAI SDK exposes via default export
  return MockOpenAI;
}

describe('azureAdapter — basic shape', () => {
  it('exports a ReviewEngine with required methods', async () => {
    const { azureAdapter } = await import('../src/adapters/review-engine/azure.ts');
    assert.equal(typeof azureAdapter.review, 'function');
    assert.equal(typeof azureAdapter.estimateTokens, 'function');
    assert.equal(azureAdapter.name, 'azure');
    assert.equal(azureAdapter.apiVersion, '1.0.0');
  });
});

describe('azureAdapter — env validation', () => {
  after(restoreEnv);

  it('throws when AZURE_OPENAI_API_KEY missing', async () => {
    delete process.env.AZURE_OPENAI_API_KEY;
    process.env.AZURE_OPENAI_ENDPOINT = 'https://x.openai.azure.com';
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'gpt4';
    const { azureAdapter } = await import('../src/adapters/review-engine/azure.ts');
    await assert.rejects(
      () => azureAdapter.review({ content: 'x', kind: 'file-batch' }),
      (err: Error) => err.message.includes('AZURE_OPENAI_API_KEY'),
    );
  });

  it('throws when AZURE_OPENAI_ENDPOINT missing', async () => {
    process.env.AZURE_OPENAI_API_KEY = 'k';
    delete process.env.AZURE_OPENAI_ENDPOINT;
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'gpt4';
    const { azureAdapter } = await import('../src/adapters/review-engine/azure.ts');
    await assert.rejects(
      () => azureAdapter.review({ content: 'x', kind: 'file-batch' }),
      (err: Error) => err.message.includes('AZURE_OPENAI_ENDPOINT'),
    );
  });

  it('throws when AZURE_OPENAI_DEPLOYMENT_NAME missing', async () => {
    process.env.AZURE_OPENAI_API_KEY = 'k';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://x.openai.azure.com';
    delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
    const { azureAdapter } = await import('../src/adapters/review-engine/azure.ts');
    await assert.rejects(
      () => azureAdapter.review({ content: 'x', kind: 'file-batch' }),
      (err: Error) => err.message.includes('AZURE_OPENAI_DEPLOYMENT_NAME'),
    );
  });
});

describe('azureAdapter — deployment routing (mocked SDK)', () => {
  before(() => {
    process.env.AZURE_OPENAI_API_KEY = 'azure-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://my-resource.openai.azure.com';
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'gpt-4o-deployment';
  });
  after(async () => {
    const { __setAzureSdkLoader } = await import('../src/adapters/review-engine/azure.ts');
    __setAzureSdkLoader(null);
    restoreEnv();
  });

  it('builds deployment-routed baseURL and sets api-version query', async () => {
    const capture: AzureCapture = {};
    const Mock = makeMockOpenAICtor(
      capture,
      '### [NOTE] x\nbody\n**Suggestion:** y',
    );
    const { azureAdapter, __setAzureSdkLoader } = await import(
      '../src/adapters/review-engine/azure.ts'
    );
    __setAzureSdkLoader(async () => Mock);
    const result = await azureAdapter.review({ content: 'x', kind: 'file-batch' });
    assert.equal(
      capture.baseURL,
      'https://my-resource.openai.azure.com/openai/deployments/gpt-4o-deployment',
    );
    assert.equal(capture.defaultQuery?.['api-version'], '2024-10-21');
    assert.equal(capture.defaultHeaders?.['api-key'], 'azure-key');
    assert.equal(capture.sentModel, 'gpt-4o-deployment');
    assert.equal(result.usage?.input, 11);
    assert.equal(result.usage?.output, 22);
    __setAzureSdkLoader(null);
  });

  it('strips trailing slash from endpoint via URL origin normalization', async () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://my-resource.openai.azure.com/';
    const capture: AzureCapture = {};
    const Mock = makeMockOpenAICtor(capture, '### [NOTE] x\nbody\n**Suggestion:** y');
    const { azureAdapter, __setAzureSdkLoader } = await import(
      '../src/adapters/review-engine/azure.ts'
    );
    __setAzureSdkLoader(async () => Mock);
    await azureAdapter.review({ content: 'x', kind: 'file-batch' });
    assert.equal(
      capture.baseURL,
      'https://my-resource.openai.azure.com/openai/deployments/gpt-4o-deployment',
    );
    __setAzureSdkLoader(null);
  });

  it('percent-encodes deployment names with unsafe characters', async () => {
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'my dep/with spaces';
    const capture: AzureCapture = {};
    const Mock = makeMockOpenAICtor(capture, '### [NOTE] x\nbody\n**Suggestion:** y');
    const { azureAdapter, __setAzureSdkLoader } = await import(
      '../src/adapters/review-engine/azure.ts'
    );
    __setAzureSdkLoader(async () => Mock);
    await azureAdapter.review({ content: 'x', kind: 'file-batch' });
    assert.ok(
      capture.baseURL?.endsWith('/openai/deployments/my%20dep%2Fwith%20spaces'),
      `expected percent-encoded segment, got ${capture.baseURL}`,
    );
    __setAzureSdkLoader(null);
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'gpt-4o-deployment';
  });

  it('honors AZURE_OPENAI_API_VERSION override', async () => {
    process.env.AZURE_OPENAI_API_VERSION = '2025-01-01';
    const capture: AzureCapture = {};
    const Mock = makeMockOpenAICtor(capture, '### [NOTE] x\nbody\n**Suggestion:** y');
    const { azureAdapter, __setAzureSdkLoader } = await import(
      '../src/adapters/review-engine/azure.ts'
    );
    __setAzureSdkLoader(async () => Mock);
    await azureAdapter.review({ content: 'x', kind: 'file-batch' });
    assert.equal(capture.defaultQuery?.['api-version'], '2025-01-01');
    __setAzureSdkLoader(null);
    delete process.env.AZURE_OPENAI_API_VERSION;
  });
});

describe('azureAdapter — endpoint validation (Codex WARNING #1)', () => {
  before(() => {
    process.env.AZURE_OPENAI_API_KEY = 'azure-key';
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'gpt-4o-deployment';
  });
  after(restoreEnv);

  it('rejects http:// (non-https) endpoint', async () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'http://my-resource.openai.azure.com';
    const { azureAdapter } = await import('../src/adapters/review-engine/azure.ts');
    await assert.rejects(
      () => azureAdapter.review({ content: 'x', kind: 'file-batch' }),
      (err: Error) => err.message.includes('https://'),
    );
  });

  it('rejects endpoint with path component', async () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://my-resource.openai.azure.com/foo';
    const { azureAdapter } = await import('../src/adapters/review-engine/azure.ts');
    await assert.rejects(
      () => azureAdapter.review({ content: 'x', kind: 'file-batch' }),
      (err: Error) => err.message.includes('origin only'),
    );
  });

  it('rejects endpoint with query string', async () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://my-resource.openai.azure.com?evil=1';
    const { azureAdapter } = await import('../src/adapters/review-engine/azure.ts');
    await assert.rejects(
      () => azureAdapter.review({ content: 'x', kind: 'file-batch' }),
      (err: Error) => err.message.includes('origin only'),
    );
  });

  it('rejects endpoint with hash fragment', async () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://my-resource.openai.azure.com#frag';
    const { azureAdapter } = await import('../src/adapters/review-engine/azure.ts');
    await assert.rejects(
      () => azureAdapter.review({ content: 'x', kind: 'file-batch' }),
      (err: Error) => err.message.includes('origin only'),
    );
  });

  it('rejects malformed endpoint URL', async () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'not-a-url';
    const { azureAdapter } = await import('../src/adapters/review-engine/azure.ts');
    await assert.rejects(
      () => azureAdapter.review({ content: 'x', kind: 'file-batch' }),
      (err: Error) => err.message.includes('not a valid URL') || err.message.includes('https://'),
    );
  });
});

describe('azureAdapter — error mapping (mocked SDK)', () => {
  before(() => {
    process.env.AZURE_OPENAI_API_KEY = 'azure-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://my-resource.openai.azure.com';
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'gpt-4o-deployment';
  });
  after(async () => {
    const { __setAzureSdkLoader } = await import('../src/adapters/review-engine/azure.ts');
    __setAzureSdkLoader(null);
    restoreEnv();
  });

  async function runWithStatus(status: number): Promise<Error & { code?: string }> {
    const capture: AzureCapture = { forceErrorStatus: status };
    const Mock = makeMockOpenAICtor(capture, '');
    const { azureAdapter, __setAzureSdkLoader } = await import(
      '../src/adapters/review-engine/azure.ts'
    );
    __setAzureSdkLoader(async () => Mock);
    try {
      await azureAdapter.review({ content: 'x', kind: 'file-batch' });
      throw new Error('should reject');
    } catch (err) {
      return err as Error & { code?: string };
    } finally {
      __setAzureSdkLoader(null);
    }
  }

  it('401 maps to auth', async () => {
    assert.equal((await runWithStatus(401)).code, 'auth');
  });
  it('429 maps to rate_limit', async () => {
    assert.equal((await runWithStatus(429)).code, 'rate_limit');
  });
  it('503 maps to transient_network', async () => {
    assert.equal((await runWithStatus(503)).code, 'transient_network');
  });

  it('503 transient_network is retryable=true (bugbot regression)', async () => {
    const err = (await runWithStatus(503)) as Error & { retryable?: boolean };
    assert.equal(err.retryable, true);
  });

  it('429 rate_limit is retryable=true', async () => {
    const err = (await runWithStatus(429)) as Error & { retryable?: boolean };
    assert.equal(err.retryable, true);
  });

  it('401 auth is retryable=false', async () => {
    const err = (await runWithStatus(401)) as Error & { retryable?: boolean };
    assert.equal(err.retryable, false);
  });
});

describe('adapter loader — azure registration', () => {
  before(() => {
    process.env.AZURE_OPENAI_API_KEY = 'k';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://x.openai.azure.com';
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'd';
  });
  after(restoreEnv);

  it('loads azure adapter by name', async () => {
    const { loadAdapter } = await import('../src/adapters/loader.ts');
    const adapter = await loadAdapter({ point: 'review-engine', ref: 'azure' });
    assert.equal(adapter.name, 'azure');
  });
});
