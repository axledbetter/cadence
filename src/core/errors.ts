// src/core/errors.ts

export type ErrorCode =
  | 'auth' | 'rate_limit' | 'transient_network' | 'invalid_config'
  | 'adapter_bug' | 'user_input' | 'budget_exceeded' | 'concurrency_lock' | 'superseded'
  | 'no_previous_deploy'
  | 'not_found'
  // v6 Run State Engine — persistence layer error codes.
  | 'lock_held'        // another writer owns the run's advisory lock
  | 'corrupted_state'  // state.json is unreadable/invalid and not recoverable from events
  | 'partial_write'    // events.ndjson tail had a truncated JSON line
  // v6.2.1 — orchestrator resume preflight refused to auto-decide; the run
  // requires explicit operator intervention (`--force-replay` or manual
  // ledger inspection). Emitted as a `replay.override`-eligible refusal.
  | 'needs_human'
  // v8.6 — implement-phase schema-change manifest is missing entries
  // (or carries orphans) relative to the actual diff. Caller-fixable.
  | 'incomplete_phase_output'
  // v8.6 — manifest entry violates a profile.schemaChangePolicy rule
  // (NOT NULL without backfill, DROP COLUMN without deprecation, RLS
  // weakening without security review, destructive without expand-
  // contract, missing pairedWith PR).
  | 'schema_policy_violation';

export interface GuardrailErrorOptions {
  code: ErrorCode;
  retryable?: boolean;
  provider?: string;
  step?: string;
  details?: Record<string, unknown>;
}

const DEFAULT_RETRYABLE: Record<ErrorCode, boolean> = {
  auth: false, rate_limit: true, transient_network: true, invalid_config: false,
  adapter_bug: false, user_input: false, budget_exceeded: false,
  concurrency_lock: false, superseded: false,
  no_previous_deploy: false,
  // 404 — caller-fixable (slug typo, wrong scope). Not retryable; the
  // resource won't materialize on its own.
  not_found: false,
  // v6 Run State Engine — none retry automatically; takeover/recovery is an
  // explicit user-driven decision (--force-takeover / --force).
  lock_held: false,
  corrupted_state: false,
  partial_write: false,
  // v6.2.1 — needs_human is by definition a stop-the-pipeline signal; the
  // user (or `--force-replay`) decides whether to retry.
  needs_human: false,
  // v8.6 — schema manifest fixups are caller-driven (agent must update
  // the manifest). Not retryable.
  incomplete_phase_output: false,
  schema_policy_violation: false,
};

export class GuardrailError extends Error {
  code: ErrorCode;
  retryable: boolean;
  provider?: string;
  step?: string;
  details: Record<string, unknown>;

  constructor(message: string, options: GuardrailErrorOptions) {
    super(message);
    this.name = 'GuardrailError';
    this.code = options.code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[options.code];
    this.provider = options.provider;
    this.step = options.step;
    this.details = options.details ?? {};
  }
}
