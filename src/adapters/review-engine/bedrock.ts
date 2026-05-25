import { parseReviewOutput } from './parse-output.ts';
import { GuardrailError } from '../../core/errors.ts';
import type { Capabilities } from '../base.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from './types.ts';
import { buildSystemPrompt, classifyError } from './prompt-builder.ts';
import { loadBedrockRuntime } from '../sdk-loader.ts';

// Test seam: tests can override the SDK loader without monkey-patching the
// (read-only) module namespace export. Production code keeps using the
// shared loader; only tests touch this.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sdkLoader: () => Promise<any> = loadBedrockRuntime;
/** @internal — test-only override hook. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function __setBedrockSdkLoader(fn: (() => Promise<any>) | null): void {
  _sdkLoader = fn ?? loadBedrockRuntime;
}

const DEFAULT_MODEL = 'anthropic.claude-sonnet-4-5-20250929-v1:0';
const DEFAULT_REGION = 'us-east-1';
const MAX_OUTPUT_TOKENS = 4096;

// Cost per million tokens (USD) — Claude Sonnet 4.5 on Bedrock (matches direct
// Anthropic Sonnet pricing); used only when usage metadata is reported back by
// Bedrock. Caller can override via env `BEDROCK_COST_INPUT_PER_M` /
// `BEDROCK_COST_OUTPUT_PER_M` for non-default models.
const COST_PER_M_INPUT = Number(process.env.BEDROCK_COST_INPUT_PER_M ?? 3.0);
const COST_PER_M_OUTPUT = Number(process.env.BEDROCK_COST_OUTPUT_PER_M ?? 15.0);

const SYSTEM_PROMPT_TEMPLATE = `You are a senior software architect reviewing code changes for quality, security, and correctness.

The codebase context:
{STACK}{GIT_CONTEXT}{DESIGN_SCHEMA}

Provide structured feedback in exactly this format:

## Review Summary
One paragraph overall assessment.

## Findings

For each finding, use this format:
### [CRITICAL|WARNING|NOTE] <short title>
<explanation>
**Suggestion:** <actionable fix>

Rules:
- CRITICAL: Blocks merge (security issues, data loss risks, broken contracts)
- WARNING: Should address before merging (logic errors, missing error handling, test gaps)
- NOTE: Improvement suggestion (style, performance, clarity)
- Maximum 10 findings, ranked by severity
- Be specific and constructive
- Reference the file and line when possible`;

// Bedrock returns the standard Anthropic Messages payload for Claude family
// models. We use the modern `messages` API shape (not the legacy `completion`
// shape) for forward compat with Sonnet/Opus 4.x families.
interface BedrockAnthropicResponseBody {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export const bedrockAdapter: ReviewEngine = {
  name: 'bedrock',
  apiVersion: '1.0.0',

  getCapabilities(): Capabilities {
    return { structuredOutput: false, streaming: true, maxContextTokens: 200000, inlineComments: false };
  },

  estimateTokens(content: string): number {
    return Math.ceil(content.length / 3.5);
  },

  async review(input: ReviewInput): Promise<ReviewOutput> {
    const opts = (input.context as Record<string, unknown> | undefined) ?? {};

    // Credential resolution: prefer the AWS SDK default credential provider
    // chain (ECS task roles, EC2 instance metadata, EKS web identity, SSO,
    // shared config files, env vars) — DO NOT require static env-var keys.
    // This is the secure-by-default pattern for ECS/EKS deployments where
    // long-lived AWS keys should never be present in env.
    //
    // If the caller has explicitly set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
    // (e.g. local dev with IAM user keys), the SDK will pick those up via the
    // chain automatically — no special-casing needed here.
    const accessKey = process.env.AWS_ACCESS_KEY_ID;
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
    const partialEnvCreds = (!!accessKey) !== (!!secretKey);
    if (partialEnvCreds) {
      throw new GuardrailError(
        'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together (or neither — fall back to the AWS SDK default credential chain)',
        { code: 'auth', provider: 'bedrock' },
      );
    }

    const region = (opts['region'] as string | undefined) ?? process.env.AWS_REGION ?? DEFAULT_REGION;
    const model = (opts['model'] as string | undefined) ?? process.env.BEDROCK_MODEL_ID ?? DEFAULT_MODEL;

    const systemPrompt = buildSystemPrompt(input, SYSTEM_PROMPT_TEMPLATE);
    const requestBody = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: MAX_OUTPUT_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Please review the following:\n\n---\n\n${input.content}` }],
    };

    const { BedrockRuntimeClient, InvokeModelCommand, InvokeModelWithResponseStreamCommand } =
      await _sdkLoader();

    // Build the client config: only pass explicit `credentials` when both
    // env-var keys are set, otherwise let the SDK resolve via its default
    // chain (task role / instance metadata / SSO / shared config).
    const clientConfig: Record<string, unknown> = { region };
    if (accessKey && secretKey) {
      const sessionToken = process.env.AWS_SESSION_TOKEN;
      clientConfig['credentials'] = {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
        ...(sessionToken ? { sessionToken } : {}),
      };
    }
    const client = new BedrockRuntimeClient(clientConfig);

    const useStreaming = opts['stream'] === true;

    try {
      if (useStreaming) {
        const cmd = new InvokeModelWithResponseStreamCommand({
          modelId: model,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(requestBody),
        });
        const response = await client.send(cmd);

        let rawOutput = '';
        let usage: { input: number; output: number } | undefined;
        if (response.body) {
          for await (const chunk of response.body) {
            const bytes = chunk.chunk?.bytes;
            if (!bytes) continue;
            const decoded = JSON.parse(new TextDecoder().decode(bytes)) as {
              type?: string;
              delta?: { text?: string };
              usage?: { input_tokens?: number; output_tokens?: number };
              message?: { usage?: { input_tokens?: number; output_tokens?: number } };
            };
            if (decoded.type === 'content_block_delta' && decoded.delta?.text) {
              rawOutput += decoded.delta.text;
            }
            const u = decoded.usage ?? decoded.message?.usage;
            if (u?.input_tokens !== undefined && u?.output_tokens !== undefined) {
              usage = { input: u.input_tokens, output: u.output_tokens };
            }
          }
        }

        const costUSD = usage
          ? (usage.input / 1_000_000) * COST_PER_M_INPUT +
            (usage.output / 1_000_000) * COST_PER_M_OUTPUT
          : undefined;

        return {
          findings: parseReviewOutput(rawOutput, 'bedrock'),
          rawOutput,
          usage: usage ? { ...usage, costUSD } : undefined,
        };
      }

      const cmd = new InvokeModelCommand({
        modelId: model,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(requestBody),
      });
      const response = await client.send(cmd);

      const bodyBytes = response.body;
      if (!bodyBytes) {
        return { findings: [], rawOutput: '' };
      }
      const parsed = JSON.parse(new TextDecoder().decode(bodyBytes)) as BedrockAnthropicResponseBody;
      const rawOutput = (parsed.content ?? [])
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join('');

      const inputTokens = parsed.usage?.input_tokens;
      const outputTokens = parsed.usage?.output_tokens;
      const costUSD =
        inputTokens !== undefined && outputTokens !== undefined
          ? (inputTokens / 1_000_000) * COST_PER_M_INPUT +
            (outputTokens / 1_000_000) * COST_PER_M_OUTPUT
          : undefined;

      return {
        findings: parseReviewOutput(rawOutput, 'bedrock'),
        rawOutput,
        usage:
          inputTokens !== undefined && outputTokens !== undefined
            ? { input: inputTokens, output: outputTokens, costUSD }
            : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = classifyError(message);
      throw new GuardrailError(`Bedrock review call failed: ${message}`, {
        code,
        provider: 'bedrock',
        retryable: code === 'rate_limit' || code === 'transient_network',
      });
    }
  },
};

export default bedrockAdapter;
