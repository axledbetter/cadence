import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Smoke test: runDoctor is exported and returns the right shape
describe('runDoctor', () => {
  it('exports runDoctor as a function', async () => {
    const mod = await import('../../src/cli/preflight.ts');
    assert.equal(typeof mod.runDoctor, 'function');
  });

  it('returns { blockers, warnings } with numeric values', async () => {
    const { runDoctor } = await import('../../src/cli/preflight.ts');
    const result = await runDoctor();
    assert.equal(typeof result.blockers, 'number');
    assert.equal(typeof result.warnings, 'number');
  });

  // v8.1.1 — issue #210 acceptance bullet: doctor surfaces unknown
  // budgets.* keys prominently. Runs in a tmp cwd to isolate from the
  // real repo's guardrail.config.yaml.
  it('surfaces budgets.* unknown-key warning when guardrail.config.yaml has a typo', async t => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-budgets-'));
    fs.writeFileSync(
      path.join(tmpDir, 'guardrail.config.yaml'),
      'configVersion: 1\nbudgets:\n  perRunUSD: 5\n  perSubAgentUsd: 2\n',
    );

    const origCwd = process.cwd();
    const logs: string[] = [];
    const logSpy = t.mock.method(console, 'log', (...args: unknown[]) => {
      logs.push(args.map(a => String(a)).join(' '));
    });
    try {
      process.chdir(tmpDir);
      const { runDoctor } = await import('../../src/cli/preflight.ts');
      await runDoctor();
      const all = logs.join('\n');
      assert.match(all, /budgets unknown key/);
      assert.match(all, /perSubAgentUsd/);
      assert.match(all, /did you mean "perSubagentUSD"/);
    } finally {
      process.chdir(origCwd);
      logSpy.mock.restore();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
