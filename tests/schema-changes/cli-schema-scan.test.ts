import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSchemaScan } from '../../src/cli/schema-scan.ts';

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-schema-scan-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 't@t.test'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'init', '-q'], { cwd: dir });
  return dir;
}

describe('cadence schema scan — skeleton generation', () => {
  it('empty diff → returns []', async () => {
    const cwd = tmpRepo();
    const r = await runSchemaScan({ cwd, schemaPaths: ['data/deltas/*.sql'], format: 'json' });
    assert.equal(r.exit, 0);
    assert.match(r.stdout, /^\[\]/);
  });

  it('one new SQL file → manifest entries', async () => {
    const cwd = tmpRepo();
    fs.mkdirSync(path.join(cwd, 'data', 'deltas'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'data', 'deltas', '20260527.sql'),
      'CREATE TABLE foo (id uuid PRIMARY KEY);');
    const r = await runSchemaScan({ cwd, schemaPaths: ['data/deltas/*.sql'], format: 'json' });
    assert.equal(r.exit, 0);
    const entries = JSON.parse(r.stdout);
    assert.ok(Array.isArray(entries));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'sql.create_table');
    assert.equal(entries[0].objectName, 'foo');
  });

  it('opt-in gate: no schemaPaths → returns non-zero with helpful error', async () => {
    const cwd = tmpRepo();
    const r = await runSchemaScan({ cwd, schemaPaths: [], format: 'json' });
    assert.equal(r.exit, 1);
    assert.match(r.stderr, /schemaPaths is empty/);
  });

  it('YAML output renders as a YAML array', async () => {
    const cwd = tmpRepo();
    fs.mkdirSync(path.join(cwd, 'data', 'deltas'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'data', 'deltas', '20260527.sql'),
      'CREATE TABLE foo (id uuid PRIMARY KEY);');
    const r = await runSchemaScan({ cwd, schemaPaths: ['data/deltas/*.sql'], format: 'yaml' });
    assert.equal(r.exit, 0);
    assert.match(r.stdout, /kind: sql\.create_table/);
  });

  it('--out writes to file', async () => {
    const cwd = tmpRepo();
    fs.mkdirSync(path.join(cwd, 'data', 'deltas'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'data', 'deltas', '20260527.sql'),
      'CREATE TABLE foo (id uuid PRIMARY KEY);');
    const outFile = path.join(cwd, 'manifest.json');
    const r = await runSchemaScan({ cwd, schemaPaths: ['data/deltas/*.sql'], format: 'json', outputPath: outFile });
    assert.equal(r.exit, 0);
    assert.ok(fs.existsSync(outFile));
    const written = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.equal(written[0].kind, 'sql.create_table');
  });
});
