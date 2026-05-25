// tests/cohere-adapter.test.ts
//
// Unit tests for the Cohere review adapter. Uses the adapter's
// `__setCohereSdkLoader` test seam to substitute a fake `cohere-ai` client
// constructor without hitting the network.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const ORIGINAL_ENV = {
  COHERE_API_KEY: process.env.COHERE_API_KEY,
  COHERE_MODEL: process.env.COHERE_MODEL,
};

function restoreEnv(): void {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

interface CohereCapture {
  token?: string;
  sentModel?: string;
  forceErrorStatus?: number;
  streaming?: boolean;
}

function makeMockCohereCtor(capture: CohereCapture, responseText: string) {
  async function* streamChunks(text: string) {
    for (let i = 0; i < text.length; i += 5) {
      yield {
        type: 'content-delta',
        delta: { message: { content: { text: text.slice(i, i + 5) } } },
      };
    }
    yield {
      type: 'message-end',
      usage: { tokens: { inputTokens: 8, outputTokens: 12 } },
    };
  }

  class MockCohereClient {
    constructor(opts: { token: string }) {
      capture.token = opts.token;
    }
    async chat(args: { model: string }) {
      capture.sentModel = args.model;
      if (capture.forceErrorStatus !== undefined) {
        const status = capture.forceErrorStatus;
        let msg = `HTTP ${status}`;
        if (status === 401 || status === 403) msg = `unauthorized (${status})`;
        else if (status === 429) msg = `rate limit (${status})`;
        else if (status >= 500) msg = `network failure`;
        throw new Error(msg);
      }
      return {
        message: { content: [{ type: 'text', text: responseText }] },
        usage: { tokens: { inputTokens: 8, outputTokens: 12 } },
      };
    }
    async chatStream(args: { model: string }) {
      capture.sentModel = args.model;
      if (capture.forceErrorStatus !== undefined) {
        const status = capture.forceErrorStatus;
        let msg = `HTTP ${status}`;
        if (status === 401 || status === 403) msg = `unauthorized (${status})`;
        else if (status === 429) msg = `rate limit (${status})`;
        else if (status >= 500) msg = `network failure`;
        throw new Error(msg);
      }
      return streamChunks(responseText);
    }
  }
  return MockCohereClient;
}

describe('cohereAdapter — basic shape', () => {
  it('exports a ReviewEngine with required methods', async () => {
    const { cohereAdapter } = await import('../src/adapters/review-engine/cohere.ts');
    assert.equal(typeof cohereAdapter.review, 'function');
    assert.equal(typeof cohereAdapter.estimateTokens, 'function');
    assert.equal(cohereAdapter.name, 'cohere');
    assert.equal(cohereAdapter.apiVersion, '1.0.0');
  });

  it('getCapabilities reports streaming:true', async () => {
    const { cohereAdapter } = await import('../src/adapters/review-engine/cohere.ts');
    assert.equal(cohereAdapter.getCapabilities()['streaming'], true);
  });
});

describe('cohereAdapter — env validation', () => {
  after(restoreEnv);

  it('throws when COHERE_API_KEY missing', async () => {
    delete process.env.COHERE_API_KEY;
    const { cohereAdapter } = await import('../src/adapters/review-engine/cohere.ts');
    await assert.rejects(
      () => cohereAdapter.review({ content: 'x', kind: 'file-batch' }),
      (err: Error) => err.message.includes('COHERE_API_KEY'),
    );
  });
});

describe('cohereAdapter — defaults and routing (mocked SDK)', () => {
  before(() => {
    process.env.COHERE_API_KEY = 'cohere-key';
  });
  after(async () => {
    const { __setCohereSdkLoader } = await import('../src/adapters/review-engine/cohere.ts');
    __setCohereSdkLoader(null);
    restoreEnv();
  });

  it('uses default model command-r-plus-08-2024 when not overridden', async () => {
    const capture: CohereCapture = {};
    const Mock = makeMockCohereCtor(capture, '### [NOTE] x\nbody\n**Suggestion:** y');
    const { cohereAdapter, __setCohereSdkLoader } = await import(
      '../src/adapters/review-engine/cohere.ts'
    );
    __setCohereSdkLoader(async () => Mock);
    const result = await cohereAdapter.review({ content: 'x', kind: 'file-batch' });
    assert.equal(capture.sentModel, 'command-r-plus-08-2024');
    assert.equal(capture.token, 'cohere-key');
    assert.equal(result.usage?.input, 8);
    assert.equal(result.usage?.output, 12);
    __setCohereSdkLoader(null);
  });

  it('honors COHERE_MODEL env override', async () => {
    process.env.COHERE_MODEL = 'command-r-08-2024';
    const capture: CohereCapture = {};
    const Mock = makeMockCohereCtor(capture, '### [NOTE] x\nbody\n**Suggestion:** y');
    const { cohereAdapter, __setCohereSdkLoader } = await import(
      '../src/adapters/review-engine/cohere.ts'
    );
    __setCohereSdkLoader(async () => Mock);
    await cohereAdapter.review({ content: 'x', kind: 'file-batch' });
    assert.equal(capture.sentModel, 'command-r-08-2024');
    __setCohereSdkLoader(null);
    delete process.env.COHERE_MODEL;
  });
});

describe('cohereAdapter — streaming (mocked SDK)', () => {
  before(() => {
    process.env.COHERE_API_KEY = 'cohere-key';
  });
  after(async () => {
    const { __setCohereSdkLoader } = await import('../src/adapters/review-engine/cohere.ts');
    __setCohereSdkLoader(null);
    restoreEnv();
  });

  it('streaming path accumulates content-delta events', async () => {
    const capture: CohereCapture = { streaming: true };
    const text = '### [CRITICAL] streamed\nIn src/foo.ts:7 problem\n**Suggestion:** fix';
    const Mock = makeMockCohereCtor(capture, text);
    const { cohereAdapter, __setCohereSdkLoader } = await import(
      '../src/adapters/review-engine/cohere.ts'
    );
    __setCohereSdkLoader(async () => Mock);
    const result = await cohereAdapter.review({
      content: 'x',
      kind: 'file-batch',
      context: { stream: true } as never,
    });
    assert.equal(result.rawOutput, text);
    assert.equal(result.findings[0]!.severity, 'critical');
    assert.equal(result.usage?.input, 8);
    assert.equal(result.usage?.output, 12);
    __setCohereSdkLoader(null);
  });
});

describe('cohereAdapter — error mapping (mocked SDK)', () => {
  before(() => {
    process.env.COHERE_API_KEY = 'cohere-key';
  });
  after(async () => {
    const { __setCohereSdkLoader } = await import('../src/adapters/review-engine/cohere.ts');
    __setCohereSdkLoader(null);
    restoreEnv();
  });

  async function runWithStatus(status: number): Promise<Error & { code?: string }> {
    const capture: CohereCapture = { forceErrorStatus: status };
    const Mock = makeMockCohereCtor(capture, '');
    const { cohereAdapter, __setCohereSdkLoader } = await import(
      '../src/adapters/review-engine/cohere.ts'
    );
    __setCohereSdkLoader(async () => Mock);
    try {
      await cohereAdapter.review({ content: 'x', kind: 'file-batch' });
      throw new Error('should reject');
    } catch (err) {
      return err as Error & { code?: string };
    } finally {
      __setCohereSdkLoader(null);
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

  it('500 transient_network is retryable=true (bugbot regression)', async () => {
    const err = (await runWithStatus(500)) as Error & { retryable?: boolean };
    assert.equal(err.retryable, true);
  });
});

describe('adapter loader — cohere registration', () => {
  before(() => {
    process.env.COHERE_API_KEY = 'k';
  });
  after(restoreEnv);

  it('loads cohere adapter by name', async () => {
    const { loadAdapter } = await import('../src/adapters/loader.ts');
    const adapter = await loadAdapter({ point: 'review-engine', ref: 'cohere' });
    assert.equal(adapter.name, 'cohere');
  });
});
