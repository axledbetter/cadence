import { parseReviewOutput } from './parse-output.ts';
import { GuardrailError } from '../../core/errors.ts';
import type { Capabilities } from '../base.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from './types.ts';
import { buildSystemPrompt, classifyError } from './prompt-builder.ts';
import { loadCohere } from '../sdk-loader.ts';

// Test seam: tests override the SDK loader without monkey-patching the
// (read-only) module namespace export.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sdkLoader: () => Promise<any> = loadCohere;
/** @internal — test-only override hook. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function __setCohereSdkLoader(fn: (() => Promise<any>) | null): void {
  _sdkLoader = fn ?? loadCohere;
}

const DEFAULT_MODEL = 'command-r-plus-08-2024';
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
 * Cohere v2 chat shape:
 *   client.chat({ model, messages: [{ role, content }] })
 * Returns: `{ message: { content: [{ type: 'text', text }] }, usage: { tokens: { inputTokens, outputTokens } } }`
 */
interface CohereV2ChatResponse {
  message?: {
    content?: Array<{ type?: string; text?: string }>;
  };
  usage?: {
    tokens?: { inputTokens?: number; outputTokens?: number };
  };
}

interface CohereV2StreamEvent {
  type?: string;
  delta?: { message?: { content?: { text?: string } } };
  usage?: { tokens?: { inputTokens?: number; outputTokens?: number } };
}

export const cohereAdapter: ReviewEngine = {
  name: 'cohere',
  apiVersion: '1.0.0',

  getCapabilities(): Capabilities {
    return { structuredOutput: false, streaming: true, maxContextTokens: 128000, inlineComments: false };
  },

  estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  },

  async review(input: ReviewInput): Promise<ReviewOutput> {
    const opts = (input.context as Record<string, unknown> | undefined) ?? {};

    const apiKey = (opts['apiKey'] as string | undefined) ?? process.env.COHERE_API_KEY;
    if (!apiKey) {
      throw new GuardrailError('COHERE_API_KEY not set', { code: 'auth', provider: 'cohere' });
    }

    const model = (opts['model'] as string | undefined) ?? process.env.COHERE_MODEL ?? DEFAULT_MODEL;
    const useStreaming = opts['stream'] === true;
    const systemPrompt = buildSystemPrompt(input, SYSTEM_PROMPT_TEMPLATE);

    const CohereClient = await _sdkLoader();
    const client = new CohereClient({ token: apiKey });

    try {
      if (useStreaming) {
        const stream = await client.chatStream({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Please review the following:\n\n---\n\n${input.content}` },
          ],
          maxTokens: MAX_OUTPUT_TOKENS,
        });

        let rawOutput = '';
        let usage: { input: number; output: number } | undefined;
        for await (const event of stream as AsyncIterable<CohereV2StreamEvent>) {
          if (event.type === 'content-delta') {
            const text = event.delta?.message?.content?.text;
            if (text) rawOutput += text;
          } else if (event.type === 'message-end') {
            const u = event.usage?.tokens;
            if (u?.inputTokens !== undefined && u?.outputTokens !== undefined) {
              usage = { input: u.inputTokens, output: u.outputTokens };
            }
          }
        }
        return {
          findings: parseReviewOutput(rawOutput, 'cohere'),
          rawOutput,
          usage,
        };
      }

      const response = (await client.chat({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Please review the following:\n\n---\n\n${input.content}` },
        ],
        maxTokens: MAX_OUTPUT_TOKENS,
      })) as CohereV2ChatResponse;

      const rawOutput = (response.message?.content ?? [])
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join('');

      const tokens = response.usage?.tokens;
      return {
        findings: parseReviewOutput(rawOutput, 'cohere'),
        rawOutput,
        usage:
          tokens?.inputTokens !== undefined && tokens?.outputTokens !== undefined
            ? { input: tokens.inputTokens, output: tokens.outputTokens }
            : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = classifyError(message);
      throw new GuardrailError(`Cohere review call failed: ${message}`, {
        code,
        provider: 'cohere',
        retryable: code === 'rate_limit',
      });
    }
  },
};

export default cohereAdapter;
