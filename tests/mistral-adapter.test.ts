// tests/mistral-adapter.test.ts
//
// Unit tests for the Mistral review adapter. Mistral uses the OpenAI wire
// shape, so we substitute a fake OpenAI ctor via `__setMistralSdkLoader`.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const ORIGINAL_ENV = {
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
  MISTRAL_MODEL: process.env.MISTRAL_MODEL,
};

function restoreEnv(): void {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

interface MistralCapture {
  apiKey?: string;
  baseURL?: string;
  sentModel?: string;
  forceErrorStatus?: number;
  streaming?: boolean;
}

function makeMockOpenAICtor(capture: MistralCapture, responseText: string) {
  async function* streamChunks(text: string) {
    for (let i = 0; i < text.length; i += 5) {
      yield { choices: [{ delta: { content: text.slice(i, i + 5) } }] };
    }
    yield {
      choices: [{ delta: {} }],
      usage: { prompt_tokens: 9, completion_tokens: 13 },
    };
  }
  class MockOpenAI {
    chat: {
      completions: {
        create: (args: { model: string; stream?: boolean }) => Promise<unknown>;
      };
    };
    constructor(opts: { apiKey: string; baseURL?: string }) {
      capture.apiKey = opts.apiKey;
      capture.baseURL = opts.baseURL;
      this.chat = {
        completions: {
          create: async (args) => {
            capture.sentModel = args.model;
            if (capture.forceErrorStatus !== undefined) {
              const status = capture.forceErrorStatus;
              let msg = `HTTP ${status}`;
              if (status === 401 || status === 403) msg = `unauthorized (${status})`;
              else if (status === 429) msg = `rate limit (${status})`;
              else if (status >= 500) msg = `network error`;
              throw new Error(msg);
            }
            if (args.stream) return streamChunks(responseText);
            return {
              choices: [{ message: { content: responseText } }],
              usage: { prompt_tokens: 9, completion_tokens: 13 },
            };
          },
        },
      };
    }
  }
  return MockOpenAI;
}

describe('mistralAdapter — basic shape', () => {
  it('exports a ReviewEngine with required methods', async () => {
    const { mistralAdapter } = await import('../src/adapters/review-engine/mistral.ts');
    assert.equal(typeof mistralAdapter.review, 'function');
    assert.equal(typeof mistralAdapter.estimateTokens, 'function');
    assert.equal(mistralAdapter.name, 'mistral');
    assert.equal(mistralAdapter.apiVersion, '1.0.0');
  });

  it('getCapabilities reports streaming:true', async () => {
    const { mistralAdapter } = await import('../src/adapters/review-engine/mistral.ts');
    assert.equal(mistralAdapter.getCapabilities()['streaming'], true);
  });
});

describe('mistralAdapter — env validation', () => {
  after(restoreEnv);

  it('throws when MISTRAL_API_KEY missing', async () => {
    delete process.env.MISTRAL_API_KEY;
    const { mistralAdapter } = await import('../src/adapters/review-engine/mistral.ts');
    await assert.rejects(
      () => mistralAdapter.review({ content: 'x', kind: 'file-batch' }),
      (err: Error) => err.message.includes('MISTRAL_API_KEY'),
    );
  });
});

describe('mistralAdapter — defaults and routing (mocked SDK)', () => {
  before(() => {
    process.env.MISTRAL_API_KEY = 'mistral-key';
  });
  after(async () => {
    const { __setMistralSdkLoader } = await import('../src/adapters/review-engine/mistral.ts');
    __setMistralSdkLoader(null);
    restoreEnv();
  });

  it('uses default model mistral-large-latest and api.mistral.ai baseURL', async () => {
    const capture: MistralCapture = {};
    const Mock = makeMockOpenAICtor(capture, '### [NOTE] x\nbody\n**Suggestion:** y');
    const { mistralAdapter, __setMistralSdkLoader } = await import(
      '../src/adapters/review-engine/mistral.ts'
    );
    __setMistralSdkLoader(async () => Mock);
    const result = await mistralAdapter.review({ content: 'x', kind: 'file-batch' });
    assert.equal(capture.sentModel, 'mistral-large-latest');
    assert.equal(capture.baseURL, 'https://api.mistral.ai/v1');
    assert.equal(capture.apiKey, 'mistral-key');
    assert.equal(result.usage?.input, 9);
    assert.equal(result.usage?.output, 13);
    __setMistralSdkLoader(null);
  });

  it('honors MISTRAL_MODEL env override', async () => {
    process.env.MISTRAL_MODEL = 'mistral-small-latest';
    const capture: MistralCapture = {};
    const Mock = makeMockOpenAICtor(capture, '### [NOTE] x\nbody\n**Suggestion:** y');
    const { mistralAdapter, __setMistralSdkLoader } = await import(
      '../src/adapters/review-engine/mistral.ts'
    );
    __setMistralSdkLoader(async () => Mock);
    await mistralAdapter.review({ content: 'x', kind: 'file-batch' });
    assert.equal(capture.sentModel, 'mistral-small-latest');
    __setMistralSdkLoader(null);
    delete process.env.MISTRAL_MODEL;
  });
});

describe('mistralAdapter — streaming (mocked SDK)', () => {
  before(() => {
    process.env.MISTRAL_API_KEY = 'mistral-key';
  });
  after(async () => {
    const { __setMistralSdkLoader } = await import('../src/adapters/review-engine/mistral.ts');
    __setMistralSdkLoader(null);
    restoreEnv();
  });

  it('streaming path accumulates delta.content chunks', async () => {
    const capture: MistralCapture = { streaming: true };
    const text = '### [WARNING] streamed\nIn src/foo.ts:33 issue\n**Suggestion:** fix';
    const Mock = makeMockOpenAICtor(capture, text);
    const { mistralAdapter, __setMistralSdkLoader } = await import(
      '../src/adapters/review-engine/mistral.ts'
    );
    __setMistralSdkLoader(async () => Mock);
    const result = await mistralAdapter.review({
      content: 'x',
      kind: 'file-batch',
      context: { stream: true } as never,
    });
    assert.equal(result.rawOutput, text);
    assert.equal(result.findings[0]!.severity, 'warning');
    assert.equal(result.usage?.input, 9);
    assert.equal(result.usage?.output, 13);
    __setMistralSdkLoader(null);
  });
});

describe('mistralAdapter — error mapping (mocked SDK)', () => {
  before(() => {
    process.env.MISTRAL_API_KEY = 'mistral-key';
  });
  after(async () => {
    const { __setMistralSdkLoader } = await import('../src/adapters/review-engine/mistral.ts');
    __setMistralSdkLoader(null);
    restoreEnv();
  });

  async function runWithStatus(status: number): Promise<Error & { code?: string }> {
    const capture: MistralCapture = { forceErrorStatus: status };
    const Mock = makeMockOpenAICtor(capture, '');
    const { mistralAdapter, __setMistralSdkLoader } = await import(
      '../src/adapters/review-engine/mistral.ts'
    );
    __setMistralSdkLoader(async () => Mock);
    try {
      await mistralAdapter.review({ content: 'x', kind: 'file-batch' });
      throw new Error('should reject');
    } catch (err) {
      return err as Error & { code?: string };
    } finally {
      __setMistralSdkLoader(null);
    }
  }

  it('401 maps to auth', async () => {
    assert.equal((await runWithStatus(401)).code, 'auth');
  });
  it('429 maps to rate_limit', async () => {
    assert.equal((await runWithStatus(429)).code, 'rate_limit');
  });
  it('500 maps to transient_network', async () => {
    assert.equal((await runWithStatus(500)).code, 'transient_network');
  });
});

describe('adapter loader — mistral registration', () => {
  before(() => {
    process.env.MISTRAL_API_KEY = 'k';
  });
  after(restoreEnv);

  it('loads mistral adapter by name', async () => {
    const { loadAdapter } = await import('../src/adapters/loader.ts');
    const adapter = await loadAdapter({ point: 'review-engine', ref: 'mistral' });
    assert.equal(adapter.name, 'mistral');
  });
});
