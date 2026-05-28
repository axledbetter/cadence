import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runSchemaPolicyCheck } from '../../src/core/schema-changes/policy-runner.ts';

function tmpRunDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-policy-runner-'));
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  return dir;
}

function writeArtifact(runDir: string, schemaChanges: unknown): void {
  fs.writeFileSync(path.join(runDir, 'artifacts', 'implement.json'), JSON.stringify({ schemaChanges }, null, 2));
}

describe('policy-runner — validates by reading implement artifact', () => {
  it('no artifact → ok with empty issues', async () => {
    const runDir = tmpRunDir();
    const r = await runSchemaPolicyCheck({ runDir });
    assert.equal(r.ok, true);
    assert.equal(r.issues.length, 0);
  });

  it('valid manifest with safe additive change → ok', async () => {
    const runDir = tmpRunDir();
    writeArtifact(runDir, [{
      file: 'data/deltas/a.sql',
      kind: 'sql.add_column',
      objectName: 'users',
      subObjectName: 'bio',
      additive: true,
      description: 'add bio',
    }]);
    const r = await runSchemaPolicyCheck({ runDir });
    assert.equal(r.ok, true);
  });

  it('SET NOT NULL without backfill → blocked', async () => {
    const runDir = tmpRunDir();
    writeArtifact(runDir, [{
      file: 'data/deltas/a.sql',
      kind: 'sql.alter_column',
      objectName: 'users',
      subObjectName: 'name',
      operation: 'SET NOT NULL',
      additive: false,
      description: 'set not null',
    }]);
    const r = await runSchemaPolicyCheck({ runDir });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === 'not_null_without_backfill'));
  });

  it('DROP COLUMN without deprecation → blocked', async () => {
    const runDir = tmpRunDir();
    writeArtifact(runDir, [{
      file: 'data/deltas/a.sql',
      kind: 'sql.drop_column',
      objectName: 'users',
      subObjectName: 'bio',
      additive: false,
      description: 'drop bio',
    }]);
    const r = await runSchemaPolicyCheck({ runDir });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === 'drop_column_without_deprecation'));
  });

  it('disabled policy → not blocked', async () => {
    const runDir = tmpRunDir();
    writeArtifact(runDir, [{
      file: 'data/deltas/a.sql',
      kind: 'sql.drop_column',
      objectName: 'users',
      subObjectName: 'bio',
      additive: false,
      description: 'drop bio',
    }]);
    const r = await runSchemaPolicyCheck({
      runDir,
      policy: { blockDropColumnWithoutDeprecation: false, destructiveRequiresExpandContract: false },
    });
    assert.equal(r.ok, true);
  });

  it('invalid manifest shape → manifest_shape_invalid code (bugbot fix)', async () => {
    const runDir = tmpRunDir();
    // Missing required `kind` field.
    writeArtifact(runDir, [{ file: 'a.sql', additive: true, description: 'x' }]);
    const r = await runSchemaPolicyCheck({ runDir });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === 'manifest_shape_invalid'));
  });

  it('corrupted artifact JSON → fail-CLOSED with manifest_shape_invalid (bugbot HIGH fix)', async () => {
    const runDir = tmpRunDir();
    fs.writeFileSync(path.join(runDir, 'artifacts', 'implement.json'), '{ broken json [[[');
    const r = await runSchemaPolicyCheck({ runDir });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === 'manifest_shape_invalid'));
  });
});
