import type OpenAINS from 'openai';
import { parseReviewOutput } from './parse-output.ts';
import { GuardrailError } from '../../core/errors.ts';
import type { Capabilities } from '../base.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from './types.ts';
import { buildSystemPrompt, classifyError } from './prompt-builder.ts';
import { loadOpenAI } from '../sdk-loader.ts';

// Test seam: tests override the OpenAI SDK loader without monkey-patching the
// (read-only) module namespace export. Production code keeps using the shared
// loader; only tests touch this.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sdkLoader: () => Promise<any> = loadOpenAI;
/** @internal — test-only override hook. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function __setAzureSdkLoader(fn: (() => Promise<any>) | null): void {
  _sdkLoader = fn ?? (loadOpenAI as unknown as () => Promise<any>);
}

const DEFAULT_API_VERSION = '2024-10-21';
const MAX_OUTPUT_TOKENS = 4096;

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

/**
 * Azure OpenAI reuses the OpenAI SDK with a deployment-routed baseURL.
 * Azure auth is via `api-key` header (NOT `Authorization: Bearer`), and the
 * URL shape is `{endpoint}/openai/deployments/{deployment}` with a required
 * `api-version` query parameter on every call.
 */
export const azureAdapter: ReviewEngine = {
  name: 'azure',
  apiVersion: '1.0.0',

  getCapabilities(): Capabilities {
    return { structuredOutput: false, streaming: false, maxContextTokens: 128000, inlineComments: false };
  },

  estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  },

  async review(input: ReviewInput): Promise<ReviewOutput> {
    const opts = (input.context as Record<string, unknown> | undefined) ?? {};

    const apiKey = (opts['apiKey'] as string | undefined) ?? process.env.AZURE_OPENAI_API_KEY;
    if (!apiKey) {
      throw new GuardrailError('AZURE_OPENAI_API_KEY not set', { code: 'auth', provider: 'azure' });
    }

    const endpoint = (opts['endpoint'] as string | undefined) ?? process.env.AZURE_OPENAI_ENDPOINT;
    if (!endpoint) {
      throw new GuardrailError(
        'AZURE_OPENAI_ENDPOINT not set (e.g. https://my-resource.openai.azure.com)',
        { code: 'auth', provider: 'azure' },
      );
    }

    const deployment =
      (opts['deployment'] as string | undefined) ??
      (opts['model'] as string | undefined) ??
      process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
    if (!deployment) {
      throw new GuardrailError(
        'AZURE_OPENAI_DEPLOYMENT_NAME not set (deployment name, not model name)',
        { code: 'invalid_config', provider: 'azure' },
      );
    }

    const apiVersion =
      (opts['apiVersion'] as string | undefined) ??
      process.env.AZURE_OPENAI_API_VERSION ??
      DEFAULT_API_VERSION;

    const normalizedEndpoint = endpoint.replace(/\/+$/, '');
    const baseURL = `${normalizedEndpoint}/openai/deployments/${deployment}`;

    const systemPrompt = buildSystemPrompt(input, SYSTEM_PROMPT_TEMPLATE);
    const OpenAI = await _sdkLoader();
    // Azure: api-key header instead of Authorization Bearer; api-version on
    // every request via defaultQuery. The dummy `apiKey` ctor arg satisfies
    // the SDK but the real auth header is the explicit `defaultHeaders` override.
    const client = new OpenAI({
      apiKey,
      baseURL,
      defaultQuery: { 'api-version': apiVersion },
      defaultHeaders: { 'api-key': apiKey },
    });

    let response: OpenAINS.Chat.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        // On Azure the SDK still requires the `model` field, but the deployment
        // path in the URL is what actually routes — convention is to pass the
        // deployment name here.
        model: deployment,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Please review the following:\n\n---\n\n${input.content}` },
        ],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = classifyError(message);
      throw new GuardrailError(`Azure OpenAI review call failed: ${message}`, {
        code,
        provider: 'azure',
        retryable: code === 'rate_limit',
      });
    }

    const rawOutput = response.choices[0]?.message.content ?? '';
    return {
      findings: parseReviewOutput(rawOutput, 'azure'),
      rawOutput,
      usage: response.usage
        ? { input: response.usage.prompt_tokens, output: response.usage.completion_tokens }
        : undefined,
    };
  },
};

export default azureAdapter;
