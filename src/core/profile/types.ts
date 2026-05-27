/**
 * User-type profile types — schema mirror + typed error class.
 *
 * Profiles overlay autopilot defaults to express user-type preferences
 * (codex pass counts, auto-merge, PR templates, audit logging, contributor
 * policy). The five shipped profiles live at `presets/profiles/<name>.yaml`
 * and are validated against `presets/schemas/profile.schema.json`.
 *
 * `ProfileConfig` mirrors the schema with every optional key materialized
 * to a concrete default value — the resolver applies defaults in code
 * (JSON Schema draft-07 `default` is annotation-only).
 *
 * `ProfileResolutionError` is the single typed error class raised for any
 * resolver failure. The `code` discriminant lets callers branch on cause
 * (e.g. show a different remediation hint for `path_traversal` vs
 * `schema_violation`).
 */

export interface CodexPassConfig {
  low: number;
  medium: number;
  high: number;
}

export interface ContributorPolicy {
  external_high_codex_passes: number;
  membership_provider: 'github-org';
}

/** Phase identifiers eligible for per-phase provider routing. */
export type PhaseName = 'review' | 'council' | 'bugbot_triage';

/** Providers exposed in the profile schema enum (v8.5.0+). */
export type PhaseProvider =
  | 'anthropic' | 'openai' | 'google' | 'bedrock'
  | 'azure' | 'cohere' | 'mistral' | 'openai-compatible';

export interface PhaseRoute {
  provider: PhaseProvider;
  model?: string;
  baseUrl?: string;
}

export interface ProfileConfig {
  profile: string;
  description: string;
  codex_passes: CodexPassConfig;
  auto_merge: boolean;
  require_risk_frontmatter: boolean;
  pause_at_steps: number[];
  audit_log_path: string | null;
  codex_explanations: boolean;
  pr_template_path: string | null;
  contributor_policy: ContributorPolicy | null;
  /**
   * Per-phase provider routing override (v8.5.0+).
   * Absent on profiles that don't pin providers — the resolver falls
   * through to env vars + adapter defaults.
   */
  phases?: Partial<Record<PhaseName, PhaseRoute>>;
}

export type ProfileResolutionSource = 'default' | 'file' | 'env' | 'flag';

export interface ResolvedProfile {
  name: string;
  config: ProfileConfig;
  source: ProfileResolutionSource;
}

export type ProfileResolutionErrorCode =
  | 'unknown'
  | 'path_traversal'
  | 'parse_error'
  | 'schema_violation'
  | 'filename_mismatch'
  | 'template_not_found';

export interface ProfileResolutionErrorOptions {
  code: ProfileResolutionErrorCode;
  /** Optional remediation hint shown after the main error message. */
  hint?: string;
  /** Optional source context (where the bad name came from). */
  source?: ProfileResolutionSource;
  /** Optional structured details for debugging. */
  details?: Record<string, unknown>;
}

export class ProfileResolutionError extends Error {
  readonly code: ProfileResolutionErrorCode;
  readonly hint?: string;
  readonly source?: ProfileResolutionSource;
  readonly details: Record<string, unknown>;

  constructor(message: string, options: ProfileResolutionErrorOptions) {
    super(message);
    this.name = 'ProfileResolutionError';
    this.code = options.code;
    this.hint = options.hint;
    this.source = options.source;
    this.details = options.details ?? {};
  }
}
