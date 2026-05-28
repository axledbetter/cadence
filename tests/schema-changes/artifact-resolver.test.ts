import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findLatestImplementArtifact } from '../../src/core/schema-changes/artifact-resolver.ts';

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-artifact-resolver-'));
}

function writeRun(cwd: string, runId: string, contents: object | null): void {
  const dir = path.join(cwd, '.claude', 'autopilot', 'runs', runId, 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  if (contents !== null) {
    fs.writeFileSync(path.join(dir, 'implement.json'), JSON.stringify(contents));
  }
}

describe('findLatestImplementArtifact', () => {
  it('returns null when no runs directory exists', () => {
    const cwd = tmpCwd();
    assert.equal(findLatestImplementArtifact(cwd), null);
  });

  it('returns null when no run has an implement.json (codex CRITICAL — fail-closed signal)', () => {
    const cwd = tmpCwd();
    writeRun(cwd, '01J5RUN1', null);
    writeRun(cwd, '01J5RUN2', null);
    assert.equal(findLatestImplementArtifact(cwd), null);
  });

  it('picks the artifact with the newest file mtime (NOT dir mtime — codex CRITICAL fix)', async () => {
    const cwd = tmpCwd();
    writeRun(cwd, '01J5OLD', { schemaChanges: [] });
    // Sleep briefly so mtimes differ.
    await new Promise((r) => setTimeout(r, 20));
    writeRun(cwd, '01J5NEW', { schemaChanges: [{ file: 'x.sql', kind: 'sql.create_table', additive: true, description: 't' }] });
    const r = findLatestImplementArtifact(cwd);
    assert.ok(r);
    assert.match(r!.runDir, /01J5NEW/);
  });

  it('ignores run dirs that have no implement.json even if the dir itself is newer (mtime fix)', async () => {
    const cwd = tmpCwd();
    writeRun(cwd, '01J5OLD', { schemaChanges: [] });
    await new Promise((r) => setTimeout(r, 20));
    // Create an empty newer run dir (no implement.json).
    fs.mkdirSync(path.join(cwd, '.claude', 'autopilot', 'runs', '01J5EMPTY'), { recursive: true });
    const r = findLatestImplementArtifact(cwd);
    assert.ok(r);
    assert.match(r!.runDir, /01J5OLD/);
  });
});
