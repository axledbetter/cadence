import { parseReviewOutput } from './parse-output.ts';
import { GuardrailError } from '../../core/errors.ts';
import type { Capabilities } from '../base.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from './types.ts';
import { buildSystemPrompt, classifyError } from './prompt-builder.ts';
import { loadOpenAI } from '../sdk-loader.ts';
import { getModelPricing } from '../pricing.ts';

// FALLBACK_MODEL is the historical hard-coded default. The dispatcher
// (`src/core/phases/dispatch.ts`) now passes the resolved model via
// `input.context.model`; this constant is only used when the adapter is
// invoked directly (e.g. legacy call sites that bypass routing). The
// legacy `CODEX_MODEL` env var is still honored as a second-level
// fallback for back-compat with v8.4.x users.
const FALLBACK_MODEL = 'gpt-5.5';
const MAX_OUTPUT_TOKENS = 4096;

// Per-million-token rates. Bugbot LOW PR #93: wired to read from the
// canonical MODEL_PRICING table so the table is no longer dead code.
// Resolution order: env override → MODEL_PRICING entry for FALLBACK_MODEL →
// numeric fallback (gpt-5.5 published rates). Costs are computed client-side
// because the OpenAI Responses API returns token counts but no $-cost field.
// TODO(v8.6.0): re-resolve pricing per-request using the actually-routed
// model so cost numbers stay accurate when phases pin different models.
const _pricing = getModelPricing(FALLBACK_MODEL);
const COST_PER_M_INPUT = Number(process.env.CODEX_COST_INPUT_PER_M ?? _pricing?.inputPer1M ?? 5.0);
const COST_PER_M_OUTPUT = Number(process.env.CODEX_COST_OUTPUT_PER_M ?? _pricing?.outputPer1M ?? 30.0);

const SYSTEM_PROMPT_TEMPLATE = `You are a senior software architect providing feedback on designs, proposals, and ideas.

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
- CRITICAL: Blocks implementation
- WARNING: Should address before implementing
- NOTE: Improvement suggestion
- Maximum 10 findings, ranked by severity
- Be specific and constructive`;

export const codexAdapter: ReviewEngine = {
  name: 'codex',
  apiVersion: '1.0.0',

  getCapabilities(): Capabilities {
    return { structuredOutput: false, streaming: false, maxContextTokens: 128000, inlineComments: false };
  },

  estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  },

  async review(input: ReviewInput): Promise<ReviewOutput> {
    const ctx = input.context as Record<string, unknown> | undefined;
    const apiKeyEnv = (ctx?.['apiKeyEnv'] as string | undefined) ?? 'OPENAI_API_KEY';
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      throw new GuardrailError(`${apiKeyEnv} not set`, { code: 'auth', provider: 'codex' });
    }
    const model = (ctx?.['model'] as string | undefined)
      ?? process.env.CODEX_MODEL
      ?? FALLBACK_MODEL;
    const baseURL = ctx?.['baseUrl'] as string | undefined;
    const systemPrompt = buildSystemPrompt(input, SYSTEM_PROMPT_TEMPLATE);

    const OpenAI = await loadOpenAI();
    const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    let response;
    try {
      response = await client.responses.create({
        model,
        instructions: systemPrompt,
        input: `Please review the following:\n\n---\n\n${input.content}`,
        max_output_tokens: MAX_OUTPUT_TOKENS,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = classifyError(message);
      throw new GuardrailError(`Codex review call failed: ${message}`, {
        code,
        provider: 'codex',
        retryable: code === 'rate_limit',
      });
    }

    const rawOutput = response.output_text ?? '';
    const costUSD = response.usage
      ? (response.usage.input_tokens / 1_000_000) * COST_PER_M_INPUT +
        (response.usage.output_tokens / 1_000_000) * COST_PER_M_OUTPUT
      : undefined;
    return {
      findings: parseReviewOutput(rawOutput, 'codex'),
      rawOutput,
      usage: response.usage
        ? { input: response.usage.input_tokens, output: response.usage.output_tokens, costUSD }
        : undefined,
    };
  },
};

export default codexAdapter;
