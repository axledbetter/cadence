// src/core/schema-changes/types.ts
//
// Typed manifest contract for the implement-phase `schemaChanges[]` output.
// Pure module: no IO, no detector imports.
//
// Spec: docs/superpowers/specs/2026-05-27-schema-change-manifests-design.md
// Plan: docs/superpowers/plans/2026-05-27-schema-change-manifests.md

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/**
 * Full taxonomy of semantic changes a detector can emit. Codex-expanded
 * to cover RLS / grants / functions / views / triggers — the highest-risk
 * surface on Supabase-style repos that was missing from the v1 draft.
 *
 * `unknown.*` kinds are first-class so detector fallbacks can emit a
 * manifest entry the engine accepts (but flags as needs-hand-authoring).
 */
export type SchemaChangeKind =
  // SQL — DDL
  | 'sql.create_table'        | 'sql.drop_table'         | 'sql.rename_table'
  | 'sql.add_column'          | 'sql.drop_column'        | 'sql.alter_column'
  | 'sql.add_index'           | 'sql.drop_index'
  | 'sql.create_view'         | 'sql.alter_view'         | 'sql.drop_view'
  | 'sql.create_function'     | 'sql.alter_function'     | 'sql.drop_function'
  | 'sql.create_trigger'      | 'sql.drop_trigger'
  | 'sql.create_extension'    | 'sql.drop_extension'
  // SQL — RLS / authorization
  | 'sql.enable_rls'          | 'sql.disable_rls'        | 'sql.force_rls'
  | 'sql.add_policy'          | 'sql.alter_policy'       | 'sql.drop_policy'
  | 'sql.grant'               | 'sql.revoke'
  | 'sql.create_role'         | 'sql.alter_role'         | 'sql.drop_role'
  // SQL — data
  | 'sql.data_backfill'       | 'sql.data_delete'        | 'sql.truncate'
  // GraphQL
  | 'graphql.add_field'       | 'graphql.remove_field'   | 'graphql.add_enum_value'
  | 'graphql.remove_enum_value' | 'graphql.deprecate_field'
  // OpenAPI
  | 'openapi.add_endpoint'    | 'openapi.remove_endpoint' | 'openapi.change_response'
  | 'openapi.change_request'
  // protobuf
  | 'protobuf.add_field'      | 'protobuf.deprecate_field' | 'protobuf.reserve_field'
  // TypeScript public surface
  | 'typescript.add_export'   | 'typescript.remove_export' | 'typescript.change_signature'
  // Catch-alls (first-class, NOT magic strings)
  | 'unknown.unparseable'     | 'unknown.unsupported_kind';

export const SCHEMA_CHANGE_KINDS: readonly SchemaChangeKind[] = [
  'sql.create_table','sql.drop_table','sql.rename_table',
  'sql.add_column','sql.drop_column','sql.alter_column',
  'sql.add_index','sql.drop_index',
  'sql.create_view','sql.alter_view','sql.drop_view',
  'sql.create_function','sql.alter_function','sql.drop_function',
  'sql.create_trigger','sql.drop_trigger',
  'sql.create_extension','sql.drop_extension',
  'sql.enable_rls','sql.disable_rls','sql.force_rls',
  'sql.add_policy','sql.alter_policy','sql.drop_policy',
  'sql.grant','sql.revoke',
  'sql.create_role','sql.alter_role','sql.drop_role',
  'sql.data_backfill','sql.data_delete','sql.truncate',
  'graphql.add_field','graphql.remove_field','graphql.add_enum_value',
  'graphql.remove_enum_value','graphql.deprecate_field',
  'openapi.add_endpoint','openapi.remove_endpoint','openapi.change_response',
  'openapi.change_request',
  'protobuf.add_field','protobuf.deprecate_field','protobuf.reserve_field',
  'typescript.add_export','typescript.remove_export','typescript.change_signature',
  'unknown.unparseable','unknown.unsupported_kind',
] as const;

export function isSchemaChangeKind(s: unknown): s is SchemaChangeKind {
  return typeof s === 'string' && (SCHEMA_CHANGE_KINDS as readonly string[]).includes(s);
}

/** Kinds that are inherently destructive even before policy evaluation. */
export const DESTRUCTIVE_KINDS: ReadonlySet<SchemaChangeKind> = new Set<SchemaChangeKind>([
  'sql.drop_table','sql.drop_column','sql.drop_index',
  'sql.drop_view','sql.drop_function','sql.drop_trigger','sql.drop_extension',
  'sql.disable_rls','sql.drop_policy','sql.revoke','sql.drop_role',
  'sql.data_delete','sql.truncate',
  'graphql.remove_field','graphql.remove_enum_value',
  'openapi.remove_endpoint',
  'typescript.remove_export','typescript.change_signature',
]);

/** Kinds that constitute RLS / authorization weakening — security-review gate. */
export const RLS_WEAKENING_KINDS: ReadonlySet<SchemaChangeKind> = new Set<SchemaChangeKind>([
  'sql.disable_rls','sql.drop_policy','sql.revoke','sql.alter_policy',
]);

// ---------------------------------------------------------------------------
// Evidence shapes
// ---------------------------------------------------------------------------

/**
 * Free-form evidence attached to a SchemaChangeEntry. Policy enforcement
 * keys off specific fields (e.g. `backfillSql` for `blockNotNullWithoutBackfill`).
 */
export interface PolicyEvidence {
  /** SQL or operation that backfills data before a destructive change. */
  backfillSql?: string;
  /** Deprecation marker (the PR that flagged the change as upcoming). */
  deprecation?: {
    introducedIn: string;     // PR # or commit sha
    removalAfter?: string;    // earliest release that may remove it
    replacement?: string;     // pointer to the new shape
  };
  /** Free-form notes about cross-runtime compatibility. */
  compatibilityNotes?: string;
  /**
   * Codex CRITICAL fix — explicit evidence for
   * `blockRlsWeakeningWithoutSecurityReview`. Without a `reviewer` field
   * the policy could not be satisfied unambiguously.
   */
  securityReview?: {
    reviewer: string;         // identity (gh login or email) of approving reviewer
    notes: string;            // free-form justification
    approvedAt?: string;      // ISO-8601
  };
}

export interface ExpandContractEvidence {
  phase: 'expand' | 'contract';
  /** Cross-PR or cross-commit reference (e.g. "#231" or sha). */
  pairedWith?: string;
  /** Required by validate: this PR's merge is gated on `pairedWith` being merged. */
  requiresMergedBefore?: string;
  /** Required by validate: backfill must be confirmed complete in prod. */
  requiresBackfillComplete?: boolean;
  /** True iff the previous-shape running code keeps working during the deployment window. */
  compatibleWithPreviousAppVersion: boolean;
  /** Which runtimes consume the schema — needed to gate concurrent old+new deploys. */
  affectedRuntimes?: Array<
    | 'nextjs-web' | 'bullmq-worker' | 'ecs-task' | 'cron'
    | 'lambda' | 'mobile-client' | 'external-api'
  >;
}

// ---------------------------------------------------------------------------
// Manifest entry
// ---------------------------------------------------------------------------

/**
 * One semantic change. **NOT one per file** — a SQL migration with five
 * statements emits five entries. Matching across detector output and
 * manifest is multiset-equal on
 * `{file, kind, objectName, subObjectName, statementIndex?, operation?}`
 * so duplicate statements still need duplicate manifest entries.
 */
export interface SchemaChangeEntry {
  /** Path relative to repoRoot. */
  file: string;
  kind: SchemaChangeKind;
  /**
   * The primary object the change targets — for SQL this is the table /
   * function / view name, for GraphQL the type name, for TypeScript the
   * file's exported symbol name, for OpenAPI the path string.
   */
  objectName?: string;
  /**
   * Codex CRITICAL fix — secondary object. For `sql.add_column` this is
   * the column name. For `graphql.add_enum_value` this is the value.
   * Required for matching multiple changes against the same `objectName`.
   */
  subObjectName?: string;
  /**
   * Codex CRITICAL fix — when multiple identical-shape statements appear
   * in the same file (e.g. two `ADD COLUMN foo` on different tables that
   * happen to share names), detectors emit a stable `statementIndex` to
   * disambiguate. Optional because most kinds are already unique by
   * `{objectName, subObjectName}`.
   */
  statementIndex?: number;
  /** Free-form qualifier (e.g. "rename A→B", "SET NOT NULL"). */
  operation?: string;
  /**
   * Whether this change is backwards-compatible with running code on the
   * previous app version. Computed by detector; agents can override only
   * via explicit `additiveOverride` (not modeled here yet — kept for v8.7).
   */
  additive: boolean;
  /** Human-readable summary that goes into the PR table. */
  description: string;
  /** SQL / instructions to undo this change if it ships and breaks prod. */
  rollback?: string;
  /** Overrides profile.schemaConsumers for this specific change. */
  consumers?: string[];
  policyEvidence?: PolicyEvidence;
  expandContract?: ExpandContractEvidence;
}

// ---------------------------------------------------------------------------
// Validators (shape-only; cross-checking lives in validator.ts)
// ---------------------------------------------------------------------------

export type ShapeResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateSchemaChangeEntry(input: unknown, idx: number): ShapeResult<SchemaChangeEntry> {
  if (input === null || typeof input !== 'object') {
    return { ok: false, error: `schemaChanges[${idx}] must be an object` };
  }
  const o = input as Record<string, unknown>;
  if (typeof o.file !== 'string' || o.file.length === 0) {
    return { ok: false, error: `schemaChanges[${idx}].file must be a non-empty string` };
  }
  if (!isSchemaChangeKind(o.kind)) {
    return { ok: false, error: `schemaChanges[${idx}].kind must be a known SchemaChangeKind` };
  }
  if (typeof o.additive !== 'boolean') {
    return { ok: false, error: `schemaChanges[${idx}].additive must be boolean` };
  }
  if (typeof o.description !== 'string' || o.description.length === 0) {
    return { ok: false, error: `schemaChanges[${idx}].description must be a non-empty string` };
  }
  if (o.objectName !== undefined && typeof o.objectName !== 'string') {
    return { ok: false, error: `schemaChanges[${idx}].objectName must be a string when present` };
  }
  if (o.subObjectName !== undefined && typeof o.subObjectName !== 'string') {
    return { ok: false, error: `schemaChanges[${idx}].subObjectName must be a string when present` };
  }
  if (o.statementIndex !== undefined && (typeof o.statementIndex !== 'number' || !Number.isInteger(o.statementIndex) || o.statementIndex < 0)) {
    return { ok: false, error: `schemaChanges[${idx}].statementIndex must be a non-negative integer when present` };
  }
  if (o.operation !== undefined && typeof o.operation !== 'string') {
    return { ok: false, error: `schemaChanges[${idx}].operation must be a string when present` };
  }
  if (o.rollback !== undefined && typeof o.rollback !== 'string') {
    return { ok: false, error: `schemaChanges[${idx}].rollback must be a string when present` };
  }
  if (o.consumers !== undefined) {
    if (!Array.isArray(o.consumers)) {
      return { ok: false, error: `schemaChanges[${idx}].consumers must be an array when present` };
    }
    for (let i = 0; i < o.consumers.length; i++) {
      if (typeof o.consumers[i] !== 'string') {
        return { ok: false, error: `schemaChanges[${idx}].consumers[${i}] must be a string` };
      }
    }
  }
  // policyEvidence / expandContract are structural — minimal shape checks only.
  if (o.policyEvidence !== undefined && (o.policyEvidence === null || typeof o.policyEvidence !== 'object')) {
    return { ok: false, error: `schemaChanges[${idx}].policyEvidence must be an object when present` };
  }
  if (o.expandContract !== undefined) {
    if (o.expandContract === null || typeof o.expandContract !== 'object') {
      return { ok: false, error: `schemaChanges[${idx}].expandContract must be an object when present` };
    }
    const ec = o.expandContract as Record<string, unknown>;
    if (ec.phase !== 'expand' && ec.phase !== 'contract') {
      return { ok: false, error: `schemaChanges[${idx}].expandContract.phase must be "expand" or "contract"` };
    }
    if (typeof ec.compatibleWithPreviousAppVersion !== 'boolean') {
      return { ok: false, error: `schemaChanges[${idx}].expandContract.compatibleWithPreviousAppVersion must be boolean` };
    }
  }
  return { ok: true, value: o as unknown as SchemaChangeEntry };
}

export function validateSchemaChanges(input: unknown): ShapeResult<SchemaChangeEntry[]> {
  if (!Array.isArray(input)) return { ok: false, error: 'schemaChanges must be an array' };
  const out: SchemaChangeEntry[] = [];
  for (let i = 0; i < input.length; i++) {
    const r = validateSchemaChangeEntry(input[i], i);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Match key (for multiset cross-checking)
// ---------------------------------------------------------------------------

/**
 * Canonical match key used by validator.ts to do multiset comparison. Two
 * entries with the same key collide — that's the desired behavior; a
 * caller doing multiset matching must count occurrences.
 */
export function matchKey(e: Pick<SchemaChangeEntry, 'file' | 'kind' | 'objectName' | 'subObjectName' | 'statementIndex' | 'operation'>): string {
  return [
    e.file,
    e.kind,
    e.objectName ?? '',
    e.subObjectName ?? '',
    e.statementIndex ?? '',
    e.operation ?? '',
  ].join('|');
}
