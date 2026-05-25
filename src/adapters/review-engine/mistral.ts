import type OpenAINS from 'openai';
import { parseReviewOutput } from './parse-output.ts';
import { GuardrailError } from '../../core/errors.ts';
import type { Capabilities } from '../base.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from './types.ts';
import { buildSystemPrompt, classifyError } from './prompt-builder.ts';
import { loadOpenAI } from '../sdk-loader.ts';

// Test seam: tests override the SDK loader without monkey-patching the
// (read-only) module namespace export.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sdkLoader: () => Promise<any> = loadOpenAI;
/** @internal — test-only override hook. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function __setMistralSdkLoader(fn: (() => Promise<any>) | null): void {
  _sdkLoader = fn ?? (loadOpenAI as unknown as () => Promise<any>);
}

const DEFAULT_MODEL = 'mistral-large-latest';
const DEFAULT_BASE_URL = 'https://api.mistral.ai/v1';
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
 * Mistral La Plateforme uses the OpenAI Chat Completions wire shape, so we
 * reuse the OpenAI SDK with a custom baseURL — no extra SDK dependency.
 * Streaming is supported.
 */
export const mistralAdapter: ReviewEngine = {
  name: 'mistral',
  apiVersion: '1.0.0',

  getCapabilities(): Capabilities {
    return { structuredOutput: false, streaming: true, maxContextTokens: 128000, inlineComments: false };
  },

  estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  },

  async review(input: ReviewInput): Promise<ReviewOutput> {
    const opts = (input.context as Record<string, unknown> | undefined) ?? {};

    const apiKey = (opts['apiKey'] as string | undefined) ?? process.env.MISTRAL_API_KEY;
    if (!apiKey) {
      throw new GuardrailError('MISTRAL_API_KEY not set', { code: 'auth', provider: 'mistral' });
    }

    const model = (opts['model'] as string | undefined) ?? process.env.MISTRAL_MODEL ?? DEFAULT_MODEL;
    const baseURL = (opts['baseUrl'] as string | undefined) ?? DEFAULT_BASE_URL;
    const useStreaming = opts['stream'] === true;

    const systemPrompt = buildSystemPrompt(input, SYSTEM_PROMPT_TEMPLATE);
    const OpenAI = await _sdkLoader();
    const client = new OpenAI({ apiKey, baseURL });

    try {
      if (useStreaming) {
        const stream = await client.chat.completions.create({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Please review the following:\n\n---\n\n${input.content}` },
          ],
        });

        let rawOutput = '';
        let usage: { input: number; output: number } | undefined;
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) rawOutput += delta;
          if (chunk.usage) {
            usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
          }
        }

        return {
          findings: parseReviewOutput(rawOutput, 'mistral'),
          rawOutput,
          usage,
        };
      }

      const response: OpenAINS.Chat.ChatCompletion = await client.chat.completions.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Please review the following:\n\n---\n\n${input.content}` },
        ],
      });

      const rawOutput = response.choices[0]?.message.content ?? '';
      return {
        findings: parseReviewOutput(rawOutput, 'mistral'),
        rawOutput,
        usage: response.usage
          ? { input: response.usage.prompt_tokens, output: response.usage.completion_tokens }
          : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = classifyError(message);
      throw new GuardrailError(`Mistral review call failed: ${message}`, {
        code,
        provider: 'mistral',
        retryable: code === 'rate_limit',
      });
    }
  },
};

export default mistralAdapter;
