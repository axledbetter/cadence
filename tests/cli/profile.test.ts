/**
 * `cadence profile {show, list}` — CLI subcommand tests.
 *
 * Covers:
 *   - `profile show` with each precedence layer (file, env, flag, default)
 *     emits the expected `Profile:` / `Source:` header + YAML body.
 *   - `profile show` STRICT mode: malformed `.autopilot/profile` fails 1.
 *   - `profile list` emits exactly the 5 shipped profiles in alphabetical
 *     order with no extras and no `templates/` entries.
 *   - `profile list` is profile-resolution-OPTIONAL — it still works in
 *     a repo with a broken `.autopilot/profile` (regression gate against
 *     the spec's "list must work when resolver doesn't" requirement).
 *
 * Tests use the same `spawnSync` pattern as `tests/cli/help-text.test.ts`
 * so they exercise the real dispatcher (`src/cli/index.ts`) end-to-end.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = path.join(ROOT, 'src', 'cli', 'index.ts');
// Absolute file:// URL to the tsx esm loader so `--import` resolves
// from any working directory (test cwds are tmpdirs that have no
// node_modules and would otherwise fail with ERR_MODULE_NOT_FOUND).
const TSX_LOADER = pathToFileURL(path.join(ROOT, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href;

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): RunResult {
  // Strip CLAUDE_AUTOPILOT_PROFILE from the inherited env unless the
  // caller sets it explicitly — otherwise an env value leaked from the
  // shell that ran `npm test` would shadow the test's intended source.
  const inheritedEnv: Record<string, string | undefined> = { ...process.env };
  delete inheritedEnv.CLAUDE_AUTOPILOT_PROFILE;
  const env: Record<string, string | undefined> = {
    ...inheritedEnv,
    ANTHROPIC_API_KEY: 'test-key',
    ...opts.env,
  };
  const result = spawnSync(
    process.execPath,
    ['--import', TSX_LOADER, ENTRY, ...args],
    {
      cwd: opts.cwd ?? ROOT,
      env: env as NodeJS.ProcessEnv,
      encoding: 'utf8',
      timeout: 20_000,
    },
  );
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? 1,
  };
}

function mkTempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-profile-cli-'));
}

function writeProfileFile(cwd: string, contents: string): void {
  const dir = path.join(cwd, '.autopilot');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile'), contents, 'utf8');
}

const SHIPPED_PROFILES = ['enterprise', 'learning', 'oss-maintainer', 'small-team', 'solo'];

describe('profile list', () => {
  it('prints exactly the 5 shipped profiles, alphabetical, one per line', () => {
    const r = runCli(['profile', 'list']);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}\nstderr: ${r.stderr}`);
    // Split, strip ANSI just in case, drop trailing blank line.
    const lines = r.stdout.split('\n').filter(l => l.length > 0);
    assert.deepEqual(lines, SHIPPED_PROFILES);
  });

  it('does NOT include the templates/ subdir or template files', () => {
    const r = runCli(['profile', 'list']);
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes('templates'), 'should not list templates/ subdir');
    assert.ok(!r.stdout.includes('pr-template'), 'should not list pr-template files');
  });

  it('works even when .autopilot/profile is malformed (profile-resolution-OPTIONAL)', () => {
    const cwd = mkTempCwd();
    try {
      writeProfileFile(cwd, 'two\nnames\n'); // multi-line → parse error if resolver fires
      const r = runCli(['profile', 'list'], { cwd });
      assert.equal(r.code, 0, `list should succeed with broken file; stderr: ${r.stderr}`);
      const lines = r.stdout.split('\n').filter(l => l.length > 0);
      assert.deepEqual(lines, SHIPPED_PROFILES);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('profile show — source: default', () => {
  it('returns solo with source=default when no file/env/flag', () => {
    const cwd = mkTempCwd();
    try {
      const r = runCli(['profile', 'show'], { cwd });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /Profile:.*solo/);
      assert.match(r.stdout, /Source:.*default/);
      // YAML body contains the materialized defaults
      assert.match(r.stdout, /profile:\s*solo/);
      assert.match(r.stdout, /auto_merge:\s*true/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('profile show — source: file', () => {
  it('reads .autopilot/profile and tags source=file', () => {
    const cwd = mkTempCwd();
    try {
      writeProfileFile(cwd, 'enterprise\n');
      const r = runCli(['profile', 'show'], { cwd });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /Profile:.*enterprise/);
      assert.match(r.stdout, /Source:.*file/);
      assert.match(r.stdout, /require_risk_frontmatter:\s*true/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('profile show — source: env', () => {
  it('CLAUDE_AUTOPILOT_PROFILE overrides file', () => {
    const cwd = mkTempCwd();
    try {
      writeProfileFile(cwd, 'enterprise\n');
      const r = runCli(['profile', 'show'], {
        cwd,
        env: { CLAUDE_AUTOPILOT_PROFILE: 'oss-maintainer' },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /Profile:.*oss-maintainer/);
      assert.match(r.stdout, /Source:.*env/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('empty CLAUDE_AUTOPILOT_PROFILE falls through to file', () => {
    const cwd = mkTempCwd();
    try {
      writeProfileFile(cwd, 'small-team\n');
      const r = runCli(['profile', 'show'], {
        cwd,
        env: { CLAUDE_AUTOPILOT_PROFILE: '' },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /Profile:.*small-team/);
      assert.match(r.stdout, /Source:.*file/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('profile show — STRICT mode (hard errors)', () => {
  it('fails 1 with parse_error when .autopilot/profile is multi-line', () => {
    const cwd = mkTempCwd();
    try {
      writeProfileFile(cwd, 'enterprise\nsolo\n');
      const r = runCli(['profile', 'show'], { cwd });
      assert.equal(r.code, 1, `expected exit 1; stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /profile show:/);
      assert.match(r.stderr, /multiple non-empty lines/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('fails 1 with unknown when env names a nonexistent profile', () => {
    const cwd = mkTempCwd();
    try {
      const r = runCli(['profile', 'show'], {
        cwd,
        env: { CLAUDE_AUTOPILOT_PROFILE: 'nonexistent' },
      });
      assert.equal(r.code, 1, `expected exit 1; stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /Unknown profile/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('profile — sub-verb dispatch', () => {
  it('prints usage with no sub-verb', () => {
    const r = runCli(['profile']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage: cadence profile/);
    assert.match(r.stdout, /show/);
    assert.match(r.stdout, /list/);
  });

  it('rejects unknown sub-verb with exit 1', () => {
    const r = runCli(['profile', 'bogus']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown sub-verb "bogus"/);
  });
});
