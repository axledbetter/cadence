// tests/bedrock-adapter.test.ts
//
// Unit tests for the AWS Bedrock review adapter. The adapter exposes a
// `__setBedrockSdkLoader` test seam so we can substitute a fake
// @aws-sdk/client-bedrock-runtime module without monkey-patching the
// (read-only) ESM namespace.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const ORIGINAL_ENV = {
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION,
  AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
  BEDROCK_MODEL_ID: process.env.BEDROCK_MODEL_ID,
};

function restoreEnv(): void {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

interface MockClientCapture {
  region?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  sentBody?: unknown;
  sentModelId?: string;
  forceErrorStatus?: number;
  streaming?: boolean;
}

function makeMockBedrockModule(capture: MockClientCapture, responseText: string) {
  async function* streamingChunks(text: string) {
    // Chunk into 5-char slices preserving every byte (newlines included). The
    // /./g regex skips `\n` by default, which silently dropped them in earlier
    // drafts of this test.
    for (let i = 0; i < text.length; i += 5) {
      const ch = text.slice(i, i + 5);
      yield {
        chunk: {
          bytes: new TextEncoder().encode(
            JSON.stringify({ type: 'content_block_delta', delta: { text: ch } }),
          ),
        },
      };
    }
    yield {
      chunk: {
        bytes: new TextEncoder().encode(
          JSON.stringify({ type: 'message_stop', usage: { input_tokens: 5, output_tokens: 7 } }),
        ),
      },
    };
  }

  class BedrockRuntimeClient {
    constructor(cfg: { region: string; credentials: MockClientCapture['credentials'] }) {
      capture.region = cfg.region;
      capture.credentials = cfg.credentials;
    }
    async send(cmd: { input: { modelId: string; body: string } }) {
      capture.sentModelId = cmd.input.modelId;
      capture.sentBody = JSON.parse(cmd.input.body);
      if (capture.forceErrorStatus !== undefined) {
        const status = capture.forceErrorStatus;
        let msg = `HTTP ${status}`;
        if (status === 401 || status === 403) msg = `unauthorized (${status}) — invalid api key`;
        else if (status === 429) msg = `rate limit exceeded (${status})`;
        else if (status >= 500) msg = `network timeout`;
        throw new Error(msg);
      }
      if (capture.streaming) {
        return { body: streamingChunks(responseText) };
      }
      const responseBody = {
        content: [{ type: 'text', text: responseText }],
        usage: { input_tokens: 10, output_tokens: 20 },
      };
      return { body: new TextEncoder().encode(JSON.stringify(responseBody)) };
    }
  }

  class InvokeModelCommand {
    input: { modelId: string; body: string };
    constructor(input: { modelId: string; body: string }) {
      this.input = input;
    }
  }
  class InvokeModelWithResponseStreamCommand {
    input: { modelId: string; body: string };
    constructor(input: { modelId: string; body: string }) {
      this.input = input;
    }
  }

  return { BedrockRuntimeClient, InvokeModelCommand, InvokeModelWithResponseStreamCommand };
}

describe('bedrockAdapter — basic shape', () => {
  it('exports a ReviewEngine with required methods', async () => {
    const { bedrockAdapter } = await import('../src/adapters/review-engine/bedrock.ts');
    assert.equal(typeof bedrockAdapter.review, 'function');
    assert.equal(typeof bedrockAdapter.estimateTokens, 'function');
    assert.equal(typeof bedrockAdapter.getCapabilities, 'function');
    assert.equal(bedrockAdapter.name, 'bedrock');
    assert.equal(bedrockAdapter.apiVersion, '1.0.0');
  });

  it('estimateTokens returns a positive integer', async () => {
    const { bedrockAdapter } = await import('../src/adapters/review-engine/bedrock.ts');
    assert.ok(bedrockAdapter.estimateTokens('hello world this is a test') > 0);
  });

  it('getCapabilities reports streaming:true and maxContextTokens >= 200000', async () => {
    const { bedrockAdapter } = await import('../src/adapters/review-engine/bedrock.ts');
    const caps = bedrockAdapter.getCapabilities();
    assert.equal(caps['streaming'], true);
    assert.ok((caps['maxContextTokens'] as number) >= 200000);
  });
});

describe('bedrockAdapter — credential resolution', () => {
  after(async () => {
    const { __setBedrockSdkLoader } = await import('../src/adapters/review-engine/bedrock.ts');
    __setBedrockSdkLoader(null);
    restoreEnv();
  });

  it('throws when AWS_ACCESS_KEY_ID set but AWS_SECRET_ACCESS_KEY missing (partial creds)', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIA_TEST';
    delete process.env.AWS_SECRET_ACCESS_KEY;
    const { bedrockAdapter } = await import('../src/adapters/review-engine/bedrock.ts');
    await assert.rejects(
      () => bedrockAdapter.review({ content: 'test', kind: 'file-batch' }),
      (err: Error) => err.message.includes('must be set together'),
    );
  });

  it('throws when AWS_SECRET_ACCESS_KEY set but AWS_ACCESS_KEY_ID missing (partial creds)', async () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    process.env.AWS_SECRET_ACCESS_KEY = 'TEST_SECRET';
    const { bedrockAdapter } = await import('../src/adapters/review-engine/bedrock.ts');
    await assert.rejects(
      () => bedrockAdapter.review({ content: 'test', kind: 'file-batch' }),
      (err: Error) => err.message.includes('must be set together'),
    );
  });

  it('falls back to default credential chain when NO env-var keys are set', async () => {
    // Bug Codex flagged: bedrock previously REQUIRED env-var keys, which
    // broke secure ECS/EKS deployments that use task roles. The adapter
    // should let the SDK resolve credentials from its default chain (ECS
    // task role / instance metadata / SSO / shared config) when env keys
    // are absent. We verify this by mocking the SDK and asserting that the
    // BedrockRuntimeClient is constructed WITHOUT an explicit `credentials`
    // field — letting the AWS SDK do its own credential resolution.
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;

    let constructorConfig: Record<string, unknown> | undefined;
    const responseBody = {
      content: [{ type: 'text', text: '### [NOTE] x\nbody\n**Suggestion:** y' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const mockMod = {
      BedrockRuntimeClient: class {
        constructor(cfg: Record<string, unknown>) {
          constructorConfig = cfg;
        }
        async send() {
          return { body: new TextEncoder().encode(JSON.stringify(responseBody)) };
        }
      },
      InvokeModelCommand: class {
        constructor(public input: unknown) {}
      },
      InvokeModelWithResponseStreamCommand: class {
        constructor(public input: unknown) {}
      },
    };
    const { bedrockAdapter, __setBedrockSdkLoader } = await import(
      '../src/adapters/review-engine/bedrock.ts'
    );
    __setBedrockSdkLoader(async () => mockMod);
    await bedrockAdapter.review({ content: 'x', kind: 'file-batch' });
    assert.ok(constructorConfig, 'BedrockRuntimeClient was not constructed');
    assert.equal(
      constructorConfig['credentials'],
      undefined,
      'expected adapter to omit `credentials` and let the SDK default chain resolve them',
    );
    assert.equal(constructorConfig['region'], 'us-east-1');
    __setBedrockSdkLoader(null);
  });

  it('uses explicit env-var credentials when BOTH keys are set', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIA_TEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'TEST_SECRET';
    let constructorConfig: Record<string, unknown> | undefined;
    const responseBody = {
      content: [{ type: 'text', text: '### [NOTE] x\nbody\n**Suggestion:** y' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const mockMod = {
      BedrockRuntimeClient: class {
        constructor(cfg: Record<string, unknown>) {
          constructorConfig = cfg;
        }
        async send() {
          return { body: new TextEncoder().encode(JSON.stringify(responseBody)) };
        }
      },
      InvokeModelCommand: class {
        constructor(public input: unknown) {}
      },
      InvokeModelWithResponseStreamCommand: class {
        constructor(public input: unknown) {}
      },
    };
    const { bedrockAdapter, __setBedrockSdkLoader } = await import(
      '../src/adapters/review-engine/bedrock.ts'
    );
    __setBedrockSdkLoader(async () => mockMod);
    await bedrockAdapter.review({ content: 'x', kind: 'file-batch' });
    const creds = constructorConfig?.['credentials'] as
      | { accessKeyId?: string; secretAccessKey?: string }
      | undefined;
    assert.equal(creds?.accessKeyId, 'AKIA_TEST');
    assert.equal(creds?.secretAccessKey, 'TEST_SECRET');
    __setBedrockSdkLoader(null);
  });
});

describe('bedrockAdapter — defaults and routing (mocked SDK)', () => {
  before(() => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIA_TEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'TEST_SECRET';
  });
  after(async () => {
    const { __setBedrockSdkLoader } = await import('../src/adapters/review-engine/bedrock.ts');
    __setBedrockSdkLoader(null);
    restoreEnv();
  });

  it('uses default model id when not overridden', async () => {
    const capture: MockClientCapture = {};
    const responseText = `### [NOTE] Test finding\nSee src/foo.ts:1 for details.\n**Suggestion:** None.`;
    const mockMod = makeMockBedrockModule(capture, responseText);
    const { bedrockAdapter, __setBedrockSdkLoader } = await import(
      '../src/adapters/review-engine/bedrock.ts'
    );
    __setBedrockSdkLoader(async () => mockMod);
    const result = await bedrockAdapter.review({ content: 'review me', kind: 'file-batch' });
    assert.equal(capture.sentModelId, 'anthropic.claude-sonnet-4-5-20250929-v1:0');
    assert.ok(result.rawOutput.length > 0);
    assert.equal(result.findings[0]!.severity, 'note');
    assert.equal(result.usage?.input, 10);
    assert.equal(result.usage?.output, 20);
    __setBedrockSdkLoader(null);
  });

  it('honors model override via context.model', async () => {
    const capture: MockClientCapture = {};
    const mockMod = makeMockBedrockModule(capture, '### [NOTE] x\nbody\n**Suggestion:** y');
    const { bedrockAdapter, __setBedrockSdkLoader } = await import(
      '../src/adapters/review-engine/bedrock.ts'
    );
    __setBedrockSdkLoader(async () => mockMod);
    await bedrockAdapter.review({
      content: 'x',
      kind: 'file-batch',
      context: { model: 'anthropic.claude-3-haiku-20240307-v1:0' } as never,
    });
    assert.equal(capture.sentModelId, 'anthropic.claude-3-haiku-20240307-v1:0');
    __setBedrockSdkLoader(null);
  });

  it('passes AWS_SESSION_TOKEN through when set (STS)', async () => {
    const capture: MockClientCapture = {};
    const mockMod = makeMockBedrockModule(capture, '### [NOTE] x\nbody\n**Suggestion:** y');
    const { bedrockAdapter, __setBedrockSdkLoader } = await import(
      '../src/adapters/review-engine/bedrock.ts'
    );
    __setBedrockSdkLoader(async () => mockMod);
    process.env.AWS_SESSION_TOKEN = 'FwoGZXIvYXdzE...session';
    try {
      await bedrockAdapter.review({ content: 'x', kind: 'file-batch' });
      assert.equal(capture.credentials?.sessionToken, 'FwoGZXIvYXdzE...session');
    } finally {
      delete process.env.AWS_SESSION_TOKEN;
      __setBedrockSdkLoader(null);
    }
  });

  it('uses default region us-east-1 when not overridden', async () => {
    const capture: MockClientCapture = {};
    const mockMod = makeMockBedrockModule(capture, '### [NOTE] x\nbody\n**Suggestion:** y');
    const { bedrockAdapter, __setBedrockSdkLoader } = await import(
      '../src/adapters/review-engine/bedrock.ts'
    );
    __setBedrockSdkLoader(async () => mockMod);
    delete process.env.AWS_REGION;
    await bedrockAdapter.review({ content: 'x', kind: 'file-batch' });
    assert.equal(capture.region, 'us-east-1');
    __setBedrockSdkLoader(null);
  });
});

describe('bedrockAdapter — error mapping (mocked SDK)', () => {
  before(() => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIA_TEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'TEST_SECRET';
  });
  after(async () => {
    const { __setBedrockSdkLoader } = await import('../src/adapters/review-engine/bedrock.ts');
    __setBedrockSdkLoader(null);
    restoreEnv();
  });

  async function runWithStatus(status: number): Promise<Error & { code?: string }> {
    const capture: MockClientCapture = { forceErrorStatus: status };
    const mockMod = makeMockBedrockModule(capture, '');
    const { bedrockAdapter, __setBedrockSdkLoader } = await import(
      '../src/adapters/review-engine/bedrock.ts'
    );
    __setBedrockSdkLoader(async () => mockMod);
    try {
      await bedrockAdapter.review({ content: 'x', kind: 'file-batch' });
      throw new Error('should have rejected');
    } catch (err) {
      return err as Error & { code?: string };
    } finally {
      __setBedrockSdkLoader(null);
    }
  }

  it('401 maps to auth code', async () => {
    const err = await runWithStatus(401);
    assert.equal(err.code, 'auth');
  });
  it('403 maps to auth code', async () => {
    const err = await runWithStatus(403);
    assert.equal(err.code, 'auth');
  });
  it('429 maps to rate_limit code', async () => {
    const err = await runWithStatus(429);
    assert.equal(err.code, 'rate_limit');
  });
  it('5xx maps to transient_network code', async () => {
    const err = await runWithStatus(503);
    assert.equal(err.code, 'transient_network');
  });
});

describe('bedrockAdapter — credential resolution error wrapping (Codex pass-2 WARNING)', () => {
  before(() => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });
  after(async () => {
    const { __setBedrockSdkLoader } = await import('../src/adapters/review-engine/bedrock.ts');
    __setBedrockSdkLoader(null);
    restoreEnv();
  });

  it('wraps AWS SDK CredentialsProviderError as auth GuardrailError', async () => {
    const mockMod = {
      BedrockRuntimeClient: class {
        async send() {
          // Simulate the @aws-sdk credential resolution failure shape
          throw new Error('Could not load credentials from any providers');
        }
      },
      InvokeModelCommand: class {
        constructor(public input: unknown) {}
      },
      InvokeModelWithResponseStreamCommand: class {
        constructor(public input: unknown) {}
      },
    };
    const { bedrockAdapter, __setBedrockSdkLoader } = await import(
      '../src/adapters/review-engine/bedrock.ts'
    );
    __setBedrockSdkLoader(async () => mockMod);
    try {
      await bedrockAdapter.review({ content: 'x', kind: 'file-batch' });
      assert.fail('should have rejected');
    } catch (err) {
      const e = err as Error & { code?: string; retryable?: boolean };
      assert.equal(e.code, 'auth');
      assert.equal(e.retryable, false);
      assert.ok(e.message.includes('default chain'));
    }
    __setBedrockSdkLoader(null);
  });
});

describe('bedrockAdapter — streaming (mocked SDK)', () => {
  before(() => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIA_TEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'TEST_SECRET';
  });
  after(async () => {
    const { __setBedrockSdkLoader } = await import('../src/adapters/review-engine/bedrock.ts');
    __setBedrockSdkLoader(null);
    restoreEnv();
  });

  it('streaming path accumulates content_block_delta chunks', async () => {
    const capture: MockClientCapture = { streaming: true };
    const text = '### [WARNING] streamed\nIn src/foo.ts:42 something\n**Suggestion:** fix it';
    const mockMod = makeMockBedrockModule(capture, text);
    const { bedrockAdapter, __setBedrockSdkLoader } = await import(
      '../src/adapters/review-engine/bedrock.ts'
    );
    __setBedrockSdkLoader(async () => mockMod);
    const result = await bedrockAdapter.review({
      content: 'x',
      kind: 'file-batch',
      context: { stream: true } as never,
    });
    assert.equal(result.rawOutput, text);
    assert.equal(result.findings[0]!.severity, 'warning');
    assert.equal(result.usage?.input, 5);
    assert.equal(result.usage?.output, 7);
    __setBedrockSdkLoader(null);
  });
});

describe('adapter loader — bedrock registration', () => {
  before(() => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIA_TEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'TEST_SECRET';
  });
  after(restoreEnv);

  it('loads bedrock adapter by name', async () => {
    const { loadAdapter } = await import('../src/adapters/loader.ts');
    const adapter = await loadAdapter({ point: 'review-engine', ref: 'bedrock' });
    assert.equal(adapter.name, 'bedrock');
  });
});
