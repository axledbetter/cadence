// src/core/schema-changes/validator.ts
//
// Pure validation functions. No IO. Cross-checks manifest entries against
// detector output (multiset match); enforces policy.

import {
  type SchemaChangeEntry,
  type PolicyEvidence,
  DESTRUCTIVE_KINDS,
  RLS_WEAKENING_KINDS,
  matchKey,
} from './types.ts';

// ---------------------------------------------------------------------------
// Cross-check & reverse-check (multiset match)
// ---------------------------------------------------------------------------

export interface CrossCheckIssue {
  severity: 'error';
  code: 'missing_manifest_entry' | 'orphan_manifest_entry';
  message: string;
  entry?: SchemaChangeEntry;
  detected?: SchemaChangeEntry;
}

export interface CrossCheckResult {
  ok: boolean;
  issues: CrossCheckIssue[];
}

function countByKey(entries: SchemaChangeEntry[]): Map<string, SchemaChangeEntry[]> {
  const out = new Map<string, SchemaChangeEntry[]>();
  for (const e of entries) {
    const k = matchKey(e);
    const bucket = out.get(k) ?? [];
    bucket.push(e);
    out.set(k, bucket);
  }
  return out;
}

/**
 * Codex CRITICAL fix — multiset match on
 * `{file, kind, objectName, subObjectName, statementIndex?, operation?}`.
 * Two detected ADD COLUMN statements on the same table require two
 * manifest entries.
 */
export function crossCheckManifest(opts: {
  manifest: SchemaChangeEntry[];
  detected: SchemaChangeEntry[];
}): CrossCheckResult {
  const manifestByKey = countByKey(opts.manifest);
  const detectedByKey = countByKey(opts.detected);
  const issues: CrossCheckIssue[] = [];

  // Every detected change must be covered by an equal number of manifest entries.
  for (const [k, detected] of detectedByKey) {
    const manifest = manifestByKey.get(k) ?? [];
    if (manifest.length < detected.length) {
      const missingCount = detected.length - manifest.length;
      issues.push({
        severity: 'error',
        code: 'missing_manifest_entry',
        message: `Detector found ${detected.length} change(s) for key "${k}" but manifest only has ${manifest.length}. Missing ${missingCount} entr${missingCount === 1 ? 'y' : 'ies'}.`,
        detected: detected[0],
      });
    }
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Reverse-check: flag manifest entries that have no matching detected change.
 * (We intentionally do NOT support an `additiveOverride` escape hatch — every
 * manifest entry must correspond to a real diff, full stop. A future v8.7 may
 * add a typed override field with reviewer evidence; until then, the
 * reverse-check is strict.)
 */
export function reverseCheckManifest(opts: {
  manifest: SchemaChangeEntry[];
  detected: SchemaChangeEntry[];
}): CrossCheckResult {
  const manifestByKey = countByKey(opts.manifest);
  const detectedByKey = countByKey(opts.detected);
  const issues: CrossCheckIssue[] = [];

  for (const [k, manifest] of manifestByKey) {
    const detected = detectedByKey.get(k) ?? [];
    if (manifest.length > detected.length) {
      const extra = manifest.length - detected.length;
      issues.push({
        severity: 'error',
        code: 'orphan_manifest_entry',
        message: `Manifest has ${manifest.length} entr${manifest.length === 1 ? 'y' : 'ies'} for key "${k}" but detector only found ${detected.length}. ${extra} orphan entr${extra === 1 ? 'y' : 'ies'}.`,
        entry: manifest[0],
      });
    }
  }
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Policy enforcement
// ---------------------------------------------------------------------------

export interface SchemaChangePolicy {
  destructiveRequiresExpandContract?: boolean;
  blockNotNullWithoutBackfill?: boolean;
  blockDropColumnWithoutDeprecation?: boolean;
  blockRlsWeakeningWithoutSecurityReview?: boolean;
}

export const DEFAULT_POLICY: Required<SchemaChangePolicy> = {
  destructiveRequiresExpandContract: true,
  blockNotNullWithoutBackfill: true,
  blockDropColumnWithoutDeprecation: true,
  blockRlsWeakeningWithoutSecurityReview: true,
};

export type PolicyIssueCode =
  | 'not_null_without_backfill'
  | 'drop_column_without_deprecation'
  | 'rls_weakening_without_security_review'
  | 'destructive_without_expand_contract'
  | 'paired_with_missing';

export interface PolicyIssue {
  severity: 'block' | 'warn';
  code: PolicyIssueCode;
  message: string;
  entry: SchemaChangeEntry;
}

export interface PolicyResult {
  ok: boolean;
  issues: PolicyIssue[];
}

function isNotNullAlter(e: SchemaChangeEntry): boolean {
  return e.kind === 'sql.alter_column' && e.operation === 'SET NOT NULL';
}

function isAddColumnNotNull(e: SchemaChangeEntry): boolean {
  // Detector flags additive=false when an ADD COLUMN has NOT NULL or similar.
  return e.kind === 'sql.add_column' && e.additive === false;
}

function hasBackfill(ev: PolicyEvidence | undefined): boolean {
  return !!ev && typeof ev.backfillSql === 'string' && ev.backfillSql.length > 0;
}

function hasDeprecation(ev: PolicyEvidence | undefined): boolean {
  return !!ev && !!ev.deprecation && typeof ev.deprecation.introducedIn === 'string' && ev.deprecation.introducedIn.length > 0;
}

function hasSecurityReview(ev: PolicyEvidence | undefined): boolean {
  return !!ev && !!ev.securityReview && typeof ev.securityReview.reviewer === 'string' && ev.securityReview.reviewer.length > 0;
}

export interface PairedWithProbe {
  /** Returns true if the referenced PR / commit exists and (for contract phases) was merged. */
  exists(pairedWith: string, requireMerged: boolean): Promise<boolean>;
}

/** Policy enforcement. Pass an optional `probe` to enforce
 *  `pairedWithMustExist` against a real gh-CLI lookup; without the probe,
 *  the rule degrades to: if `expandContract.pairedWith` is empty for a
 *  destructive contract-phase change, flag it. */
export async function enforcePolicy(opts: {
  manifest: SchemaChangeEntry[];
  policy?: SchemaChangePolicy;
  probe?: PairedWithProbe;
}): Promise<PolicyResult> {
  const pol: Required<SchemaChangePolicy> = { ...DEFAULT_POLICY, ...(opts.policy ?? {}) };
  const issues: PolicyIssue[] = [];

  for (const entry of opts.manifest) {
    // blockNotNullWithoutBackfill
    if (pol.blockNotNullWithoutBackfill && (isNotNullAlter(entry) || isAddColumnNotNull(entry))) {
      if (!hasBackfill(entry.policyEvidence)) {
        issues.push({
          severity: 'block',
          code: 'not_null_without_backfill',
          message: `${entry.kind} on ${entry.objectName ?? '(unknown)'}.${entry.subObjectName ?? ''} requires policyEvidence.backfillSql`,
          entry,
        });
      }
    }
    // blockDropColumnWithoutDeprecation
    if (pol.blockDropColumnWithoutDeprecation && entry.kind === 'sql.drop_column') {
      if (!hasDeprecation(entry.policyEvidence)) {
        issues.push({
          severity: 'block',
          code: 'drop_column_without_deprecation',
          message: `sql.drop_column on ${entry.objectName ?? '(unknown)'}.${entry.subObjectName ?? ''} requires policyEvidence.deprecation.introducedIn`,
          entry,
        });
      }
    }
    // blockRlsWeakeningWithoutSecurityReview
    if (pol.blockRlsWeakeningWithoutSecurityReview && RLS_WEAKENING_KINDS.has(entry.kind)) {
      if (!hasSecurityReview(entry.policyEvidence)) {
        issues.push({
          severity: 'block',
          code: 'rls_weakening_without_security_review',
          message: `${entry.kind} weakens RLS/authorization; requires policyEvidence.securityReview.reviewer`,
          entry,
        });
      }
    }
    // destructiveRequiresExpandContract
    if (pol.destructiveRequiresExpandContract && DESTRUCTIVE_KINDS.has(entry.kind) && entry.additive === false) {
      if (!entry.expandContract) {
        issues.push({
          severity: 'block',
          code: 'destructive_without_expand_contract',
          message: `${entry.kind} on ${entry.objectName ?? '(unknown)'} is destructive; requires expandContract block`,
          entry,
        });
      } else if (entry.expandContract.phase === 'expand' && entry.expandContract.compatibleWithPreviousAppVersion !== true) {
        issues.push({
          severity: 'block',
          code: 'destructive_without_expand_contract',
          message: `${entry.kind} expand phase must set compatibleWithPreviousAppVersion: true`,
          entry,
        });
      } else if (entry.expandContract.phase === 'contract' && (!entry.expandContract.affectedRuntimes || entry.expandContract.affectedRuntimes.length === 0)) {
        issues.push({
          severity: 'block',
          code: 'destructive_without_expand_contract',
          message: `${entry.kind} contract phase must declare affectedRuntimes`,
          entry,
        });
      }
    }
    // pairedWithMustExist
    if (entry.expandContract && entry.expandContract.pairedWith) {
      const requireMerged = entry.expandContract.phase === 'contract';
      if (opts.probe) {
        const ok = await opts.probe.exists(entry.expandContract.pairedWith, requireMerged);
        if (!ok) {
          issues.push({
            severity: 'block',
            code: 'paired_with_missing',
            message: `expandContract.pairedWith "${entry.expandContract.pairedWith}" does not exist${requireMerged ? ' or has not been merged' : ''}`,
            entry,
          });
        }
      }
    } else if (entry.expandContract && entry.expandContract.phase === 'contract' && !entry.expandContract.pairedWith) {
      issues.push({
        severity: 'block',
        code: 'paired_with_missing',
        message: `contract-phase change requires expandContract.pairedWith pointing to the expand PR`,
        entry,
      });
    }
  }

  return { ok: issues.every((i) => i.severity !== 'block'), issues };
}
