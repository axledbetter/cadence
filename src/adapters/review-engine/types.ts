import type { AdapterBase } from '../base.ts';
import type { Finding } from '../../core/findings/types.ts';

export interface ReviewInput {
  content: string;
  kind: 'spec' | 'pr-diff' | 'file-batch';
  /**
   * Free-form review context. The named fields are populated by the
   * review pipeline (`spec/plan/stack/cwd/gitSummary/designSchema`); the
   * routing fields (`provider/model/baseUrl/apiKeyEnv`) are populated
   * by `src/core/phases/dispatch.ts` so per-provider adapters can read
   * the resolved route without re-implementing precedence.
   */
  context?: {
    spec?: string;
    plan?: string;
    stack?: string;
    cwd?: string;
    gitSummary?: string;
    designSchema?: string;
    // Per-phase routing — injected by the dispatcher in v8.5.0+.
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiKeyEnv?: string;
  };
}

export interface ReviewOutput {
  findings: Finding[];
  rawOutput: string;
  usage?: { input: number; output: number; costUSD?: number };
}

export interface ReviewEngine extends AdapterBase {
  review(input: ReviewInput): Promise<ReviewOutput>;
  estimateTokens(content: string): number;
}
