import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enforcePolicy } from '../../src/core/schema-changes/validator.ts';
import type { SchemaChangeEntry } from '../../src/core/schema-changes/types.ts';

function base(over: Partial<SchemaChangeEntry>): SchemaChangeEntry {
  return {
    file: 'data/deltas/test.sql',
    kind: 'sql.add_column',
    objectName: 'users',
    subObjectName: 'foo',
    statementIndex: 0,
    additive: true,
    description: 'test',
    ...over,
  };
}

describe('policy — blockNotNullWithoutBackfill', () => {
  it('SET NOT NULL without backfill → block', async () => {
    const e = base({ kind: 'sql.alter_column', operation: 'SET NOT NULL', additive: false });
    const r = await enforcePolicy({ manifest: [e] });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === 'not_null_without_backfill'));
  });

  it('SET NOT NULL WITH backfill → passes (and still flags other rules if applicable)', async () => {
    const e = base({
      kind: 'sql.alter_column',
      operation: 'SET NOT NULL',
      additive: false,
      policyEvidence: { backfillSql: "UPDATE users SET foo='x' WHERE foo IS NULL" },
      expandContract: { phase: 'contract', pairedWith: '#231', compatibleWithPreviousAppVersion: false, affectedRuntimes: ['nextjs-web'] },
    });
    const r = await enforcePolicy({ manifest: [e] });
    // No NOT-NULL block; other rules still gate on expand-contract.
    assert.equal(r.issues.find((i) => i.code === 'not_null_without_backfill'), undefined);
  });

  it('ADD COLUMN NOT NULL (additive=false) without backfill → block', async () => {
    const e = base({ kind: 'sql.add_column', additive: false });
    const r = await enforcePolicy({ manifest: [e] });
    assert.ok(r.issues.some((i) => i.code === 'not_null_without_backfill'));
  });
});

describe('policy — blockDropColumnWithoutDeprecation', () => {
  it('DROP COLUMN without deprecation → block', async () => {
    const e = base({ kind: 'sql.drop_column', additive: false });
    const r = await enforcePolicy({ manifest: [e] });
    assert.ok(r.issues.some((i) => i.code === 'drop_column_without_deprecation'));
  });

  it('DROP COLUMN with deprecation + expand-contract → passes drop-rule', async () => {
    const e = base({
      kind: 'sql.drop_column',
      additive: false,
      policyEvidence: { deprecation: { introducedIn: 'PR#100' } },
      expandContract: { phase: 'contract', pairedWith: 'PR#100', compatibleWithPreviousAppVersion: false, affectedRuntimes: ['nextjs-web'] },
    });
    const r = await enforcePolicy({ manifest: [e] });
    assert.equal(r.issues.find((i) => i.code === 'drop_column_without_deprecation'), undefined);
  });
});

describe('policy — blockRlsWeakeningWithoutSecurityReview (codex CRITICAL evidence)', () => {
  it('DISABLE RLS without securityReview → block', async () => {
    const e = base({ kind: 'sql.disable_rls', additive: false, expandContract: { phase: 'contract', pairedWith: 'P', compatibleWithPreviousAppVersion: false, affectedRuntimes: ['nextjs-web'] } });
    const r = await enforcePolicy({ manifest: [e] });
    assert.ok(r.issues.some((i) => i.code === 'rls_weakening_without_security_review'));
  });

  it('DROP POLICY with securityReview.reviewer → passes RLS rule', async () => {
    const e = base({
      kind: 'sql.drop_policy',
      additive: false,
      policyEvidence: { securityReview: { reviewer: 'axledbetter', notes: 'reviewed' } },
      expandContract: { phase: 'contract', pairedWith: 'PR#1', compatibleWithPreviousAppVersion: false, affectedRuntimes: ['nextjs-web'] },
    });
    const r = await enforcePolicy({ manifest: [e] });
    assert.equal(r.issues.find((i) => i.code === 'rls_weakening_without_security_review'), undefined);
  });

  it('REVOKE without securityReview → block', async () => {
    const e = base({ kind: 'sql.revoke', additive: false });
    const r = await enforcePolicy({ manifest: [e] });
    assert.ok(r.issues.some((i) => i.code === 'rls_weakening_without_security_review'));
  });
});

describe('policy — destructiveRequiresExpandContract', () => {
  it('DROP TABLE without expandContract → block', async () => {
    const e = base({ kind: 'sql.drop_table', additive: false });
    const r = await enforcePolicy({ manifest: [e] });
    assert.ok(r.issues.some((i) => i.code === 'destructive_without_expand_contract'));
  });

  it('contract phase missing affectedRuntimes → block', async () => {
    const e = base({
      kind: 'sql.drop_table',
      additive: false,
      expandContract: { phase: 'contract', pairedWith: 'PR#1', compatibleWithPreviousAppVersion: false },
    });
    const r = await enforcePolicy({ manifest: [e] });
    assert.ok(r.issues.some((i) => i.code === 'destructive_without_expand_contract'));
  });

  it('contract phase with affectedRuntimes → passes destructive rule', async () => {
    const e = base({
      kind: 'sql.drop_table',
      additive: false,
      expandContract: { phase: 'contract', pairedWith: 'PR#1', compatibleWithPreviousAppVersion: false, affectedRuntimes: ['nextjs-web'] },
    });
    const r = await enforcePolicy({ manifest: [e] });
    assert.equal(r.issues.find((i) => i.code === 'destructive_without_expand_contract'), undefined);
  });

  it('expand phase must set compatibleWithPreviousAppVersion: true', async () => {
    const e = base({
      kind: 'sql.drop_table',
      additive: false,
      expandContract: { phase: 'expand', compatibleWithPreviousAppVersion: false },
    });
    const r = await enforcePolicy({ manifest: [e] });
    assert.ok(r.issues.some((i) => i.code === 'destructive_without_expand_contract'));
  });
});

describe('policy — pairedWithMustExist (probe)', () => {
  it('probe says not exists → block', async () => {
    const e = base({
      kind: 'sql.drop_column',
      additive: false,
      policyEvidence: { deprecation: { introducedIn: 'PR#100' } },
      expandContract: { phase: 'contract', pairedWith: 'PR#100', compatibleWithPreviousAppVersion: false, affectedRuntimes: ['nextjs-web'] },
    });
    const r = await enforcePolicy({
      manifest: [e],
      probe: { exists: async () => false },
    });
    assert.ok(r.issues.some((i) => i.code === 'paired_with_missing'));
  });

  it('probe says exists+merged → passes pairedWith rule', async () => {
    const e = base({
      kind: 'sql.drop_column',
      additive: false,
      policyEvidence: { deprecation: { introducedIn: 'PR#100' } },
      expandContract: { phase: 'contract', pairedWith: 'PR#100', compatibleWithPreviousAppVersion: false, affectedRuntimes: ['nextjs-web'] },
    });
    const r = await enforcePolicy({
      manifest: [e],
      probe: { exists: async () => true },
    });
    assert.equal(r.issues.find((i) => i.code === 'paired_with_missing'), undefined);
  });

  it('contract phase without pairedWith → block (even without probe)', async () => {
    const e = base({
      kind: 'sql.drop_column',
      additive: false,
      policyEvidence: { deprecation: { introducedIn: 'PR#100' } },
      expandContract: { phase: 'contract', compatibleWithPreviousAppVersion: false, affectedRuntimes: ['nextjs-web'] },
    });
    const r = await enforcePolicy({ manifest: [e] });
    assert.ok(r.issues.some((i) => i.code === 'paired_with_missing'));
  });
});

describe('policy — disable rules via SchemaChangePolicy', () => {
  it('blockNotNullWithoutBackfill: false → no NOT-NULL block', async () => {
    const e = base({ kind: 'sql.alter_column', operation: 'SET NOT NULL', additive: false });
    const r = await enforcePolicy({ manifest: [e], policy: { blockNotNullWithoutBackfill: false } });
    assert.equal(r.issues.find((i) => i.code === 'not_null_without_backfill'), undefined);
  });

  it('destructiveRequiresExpandContract: false → no destructive block', async () => {
    const e = base({ kind: 'sql.drop_table', additive: false });
    const r = await enforcePolicy({ manifest: [e], policy: { destructiveRequiresExpandContract: false } });
    assert.equal(r.issues.find((i) => i.code === 'destructive_without_expand_contract'), undefined);
  });
});
