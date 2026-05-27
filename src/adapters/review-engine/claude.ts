import type AnthropicNS from '@anthropic-ai/sdk';
import { GuardrailError } from '../../core/errors.ts';
import type { Capabilities } from '../base.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from './types.ts';
import { parseReviewOutput } from './parse-output.ts';
import { buildSystemPrompt, classifyError } from './prompt-builder.ts';
import { loadAnthropic } from '../sdk-loader.ts';

// FALLBACK_MODEL is the historical hard-coded default. The dispatcher
// (`src/core/phases/dispatch.ts`) now passes the resolved model via
// `input.context.model`; this constant is only used when the adapter is
// invoked directly (e.g. legacy call sites that bypass routing).
// TODO(v8.6.0): re-resolve pricing per-request using the routed model.
const FALLBACK_MODEL = 'claude-opus-4-7';
const MAX_OUTPUT_TOKENS = 4096;

// Cost per million tokens (USD) — opus-4-7 pricing
const COST_PER_M_INPUT = 15.0;
const COST_PER_M_OUTPUT = 75.0;

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

export const claudeAdapter: ReviewEngine = {
  name: 'claude',
  apiVersion: '1.0.0',

  getCapabilities(): Capabilities {
    return { structuredOutput: false, streaming: false, maxContextTokens: 200000, inlineComments: false };
  },

  estimateTokens(content: string): number {
    return Math.ceil(content.length / 3.5);
  },

  async review(input: ReviewInput): Promise<ReviewOutput> {
    const ctx = input.context as Record<string, unknown> | undefined;
    const apiKeyEnv = (ctx?.['apiKeyEnv'] as string | undefined) ?? 'ANTHROPIC_API_KEY';
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      throw new GuardrailError(`${apiKeyEnv} not set`, { code: 'auth', provider: 'claude' });
    }

    const model = (ctx?.['model'] as string | undefined) ?? FALLBACK_MODEL;
    const systemPrompt = buildSystemPrompt(input, SYSTEM_PROMPT_TEMPLATE);

    const Anthropic = await loadAnthropic();
    const client = new Anthropic({ apiKey });
    let response: AnthropicNS.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Please review the following:\n\n---\n\n${input.content}` }],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = classifyError(message);
      throw new GuardrailError(`Claude review call failed: ${message}`, {
        code,
        provider: 'claude',
        retryable: code === 'rate_limit',
      });
    }

    const rawOutput = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as AnthropicNS.TextBlock).text)
      .join('');

    const costUSD = response.usage
      ? (response.usage.input_tokens / 1_000_000) * COST_PER_M_INPUT +
        (response.usage.output_tokens / 1_000_000) * COST_PER_M_OUTPUT
      : undefined;

    return {
      findings: parseReviewOutput(rawOutput, 'claude'),
      rawOutput,
      usage: response.usage
        ? { input: response.usage.input_tokens, output: response.usage.output_tokens, costUSD }
        : undefined,
    };
  },
};

export default claudeAdapter;
