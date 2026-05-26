// tests/cli/migrate-classify.test.ts
//
// CLI smoke test for `cadence migrate classify --file=<path>`.
// Verifies the JSON envelope shape and exit-code matrix per the spec.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runMigrateClassify } from '../../src/cli/migrate-classify.ts';

// We use the in-process function (runMigrateClassify) rather than spawning
// the bin — the bin's hand-off to migrate-classify is a thin wrapper, and
// running in-process keeps the test deterministic and fast.

interface CapturedOutput {
  stdout: string;
  stderr: string;
}

async function runCapture(opts: { filePath: string; format?: 'json' | 'human' }): Promise<{
  exitCode: number;
  out: CapturedOutput;
}> {
  const cap: CapturedOutput = { stdout: '', stderr: '' };
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => { cap.stdout += args.map(String).join(' ') + '\n'; };
  console.error = (...args: unknown[]) => { cap.stderr += args.map(String).join(' ') + '\n'; };
  try {
    const exitCode = await runMigrateClassify(opts);
    return { exitCode, out: cap };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

function withTempSql(contents: string, fn: (p: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-classify-'));
  const p = path.join(dir, 'm.sql');
  fs.writeFileSync(p, contents, 'utf8');
  return fn(p).finally(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
}

describe('cadence migrate classify (CLI)', () => {
  it('exits 0 on additive file with JSON output', async () => {
    await withTempSql('CREATE TABLE foo (id int);', async (p) => {
      const r = await runCapture({ filePath: p });
      assert.equal(r.exitCode, 0);
      const parsed = JSON.parse(r.out.stdout);
      assert.equal(parsed.classification, 'additive');
      assert.equal(parsed.file, p);
      assert.equal(parsed.exitCode, 0);
      assert.equal(parsed.statements.length, 1);
    });
  });

  it('exits 1 on destructive file', async () => {
    await withTempSql('DROP TABLE foo;', async (p) => {
      const r = await runCapture({ filePath: p });
      assert.equal(r.exitCode, 1);
      const parsed = JSON.parse(r.out.stdout);
      assert.equal(parsed.classification, 'destructive');
    });
  });

  it('exits 2 on ambiguous file with no annotation', async () => {
    await withTempSql('GRANT SELECT ON t TO authenticated;', async (p) => {
      const r = await runCapture({ filePath: p });
      assert.equal(r.exitCode, 2);
      const parsed = JSON.parse(r.out.stdout);
      assert.equal(parsed.classification, 'ambiguous');
      assert.equal(parsed.pinned, false);
    });
  });

  it('exits 0 on ambiguous file pinned to additive', async () => {
    const sql = '-- @autopilot: classify=additive\nGRANT SELECT ON t TO authenticated;';
    await withTempSql(sql, async (p) => {
      const r = await runCapture({ filePath: p });
      assert.equal(r.exitCode, 0);
      const parsed = JSON.parse(r.out.stdout);
      assert.equal(parsed.pinnedAs, 'additive');
    });
  });

  it('exits 0 on destructive file with valid bypass', async () => {
    const sql =
      '-- @autopilot: classify=destructive_allowed_reason=incident=1234 hotfix for deprecated field\n' +
      'ALTER TABLE foo DROP COLUMN bar;';
    await withTempSql(sql, async (p) => {
      const r = await runCapture({ filePath: p });
      assert.equal(r.exitCode, 0);
      const parsed = JSON.parse(r.out.stdout);
      assert.equal(parsed.bypassed, true);
      assert.ok(parsed.bypassReason.includes('incident=1234'));
    });
  });

  it('exits 3 on missing file', async () => {
    const r = await runCapture({ filePath: '/tmp/__definitely_does_not_exist__.sql' });
    assert.equal(r.exitCode, 3);
    assert.ok(r.out.stderr.includes('could not read'));
  });

  it('human format renders without crashing', async () => {
    await withTempSql('DROP TABLE foo;', async (p) => {
      const r = await runCapture({ filePath: p, format: 'human' });
      assert.equal(r.exitCode, 1);
      assert.ok(r.out.stdout.includes('BLOCKED'));
      assert.ok(r.out.stdout.includes('drop-table'));
    });
  });
});
