import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { crossCheckManifest, reverseCheckManifest } from '../../src/core/schema-changes/validator.ts';
import type { SchemaChangeEntry } from '../../src/core/schema-changes/types.ts';

function entry(over: Partial<SchemaChangeEntry>): SchemaChangeEntry {
  return {
    file: 'data/deltas/test.sql',
    kind: 'sql.add_column',
    objectName: 'users',
    subObjectName: 'foo',
    statementIndex: 0,
    additive: true,
    description: 'add foo',
    ...over,
  };
}

describe('manifest validation — cross-check (codex CRITICAL multiset match)', () => {
  it('matched 1:1 → ok', () => {
    const e = entry({});
    const r = crossCheckManifest({ manifest: [e], detected: [e] });
    assert.equal(r.ok, true);
    assert.equal(r.issues.length, 0);
  });

  it('detected 2, manifest 1 → missing_manifest_entry', () => {
    const a = entry({ statementIndex: 0, subObjectName: 'foo' });
    const b = entry({ statementIndex: 1, subObjectName: 'bar' });
    const r = crossCheckManifest({ manifest: [a], detected: [a, b] });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === 'missing_manifest_entry'));
  });

  it('two identical-shape detected need two manifest entries (multiset)', () => {
    // Two ADD COLUMN on same table but different statementIndex.
    const a = entry({ statementIndex: 0, subObjectName: 'x' });
    const b = entry({ statementIndex: 1, subObjectName: 'x' });
    // Same key triggered by missing statementIndex differentiation in manifest.
    const manifestSingle = entry({ statementIndex: 0, subObjectName: 'x' });
    const r = crossCheckManifest({ manifest: [manifestSingle], detected: [a, b] });
    assert.equal(r.ok, false);
  });
});

describe('manifest validation — reverse-check (orphans)', () => {
  it('matched 1:1 → ok', () => {
    const e = entry({});
    const r = reverseCheckManifest({ manifest: [e], detected: [e] });
    assert.equal(r.ok, true);
  });

  it('manifest has orphan entry → orphan_manifest_entry', () => {
    const detected = entry({ statementIndex: 0 });
    const orphan = entry({ statementIndex: 99, subObjectName: 'fake' });
    const r = reverseCheckManifest({ manifest: [detected, orphan], detected: [detected] });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === 'orphan_manifest_entry'));
  });
});

describe('manifest validation — match-key includes all discriminators', () => {
  it('different statementIndex → different keys', () => {
    const a = entry({ statementIndex: 0 });
    const b = entry({ statementIndex: 1 });
    const r = crossCheckManifest({ manifest: [a], detected: [a, b] });
    assert.equal(r.ok, false);
  });

  it('different subObjectName → different keys', () => {
    const a = entry({ subObjectName: 'foo' });
    const b = entry({ subObjectName: 'bar' });
    const r = crossCheckManifest({ manifest: [a], detected: [a, b] });
    assert.equal(r.ok, false);
  });
});
