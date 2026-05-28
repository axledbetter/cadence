/**
 * Typed protocol-error class. The `code` discriminant lets callers branch
 * on cause (e.g. show different remediation for newer-unsupported vs
 * validation_failed). Mirrors the GuardrailError pattern but kept local
 * to the protocol package so the error surface stays narrowly scoped.
 */

export type ProtocolErrorCode =
  | 'invalid_version'
  | 'unknown_component'
  | 'schema_not_found'
  | 'validation_failed'
  | 'migration_failed'
  | 'migration_not_found'
  | 'newer_unsupported'
  | 'major_incompatible'
  | 'changelog_drift';

export interface ProtocolErrorOptions {
  code: ProtocolErrorCode;
  /** Optional remediation hint shown after the main error message. */
  hint?: string;
  /** Optional structured details for debugging. */
  details?: Record<string, unknown>;
  /** Optional underlying cause. */
  cause?: unknown;
}

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly hint?: string;
  readonly details: Record<string, unknown>;

  constructor(message: string, options: ProtocolErrorOptions) {
    super(message);
    this.name = 'ProtocolError';
    this.code = options.code;
    if (options.hint !== undefined) this.hint = options.hint;
    this.details = options.details ?? {};
    if (options.cause !== undefined) {
      // ES2022 Error.cause — preserve underlying error for debugging.
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}
