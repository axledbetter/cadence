/**
 * `cadence routes` CLI smoke test — spawns the real dispatcher (src/cli/index.ts)
 * end-to-end via tsx, asserts the verb prints implement + 3 routed phases with
 * per-field source attribution.
 *
 * Pattern mirrors tests/cli/profile.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = path.join(ROOT, 'src', 'cli', 'index.ts');
const TSX_LOADER = pathToFileURL(
  path.join(ROOT, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'),
).href;

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(args: string[], env: Record<string, string | undefined> = {}): RunResult {
  // Force the solo profile so the test is independent of any local
  // .autopilot/profile file.
  const inheritedEnv: Record<string, string | undefined> = { ...process.env };
  delete inheritedEnv.CLAUDE_AUTOPILOT_PROFILE;
  const finalEnv: Record<string, string | undefined> = {
    ...inheritedEnv,
    CLAUDE_AUTOPILOT_PROFILE: 'solo',
    ...env,
  };
  const result = spawnSync(
    process.execPath,
    ['--import', TSX_LOADER, ENTRY, ...args],
    { encoding: 'utf8', env: finalEnv as NodeJS.ProcessEnv },
  );
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? 1,
  };
}

describe('cadence routes', () => {
  it('#12: prints implement as runtime-bound + 3 routed phases with per-field source attribution', () => {
    const r = runCli(['routes']);
    assert.equal(r.code, 0, `expected exit 0 — stderr=${r.stderr}\nstdout=${r.stdout}`);
    assert.match(r.stdout, /implement\s+runtime-bound \(Claude Code session model\)/);
    // Each phase line: "<phase> <provider> / <model>... (provider: X, model: Y...)"
    assert.match(r.stdout, /review\s+\S+ \/ \S+.*\(provider: \w+, model: \w+/);
    assert.match(r.stdout, /council\s+\S+ \/ \S+.*\(provider: \w+, model: \w+/);
    assert.match(r.stdout, /bugbot_triage\s+\S+ \/ \S+.*\(provider: \w+, model: \w+/);
  });
});
