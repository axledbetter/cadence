/**
 * Global `--profile <name>` flag — precedence chain end-to-end.
 *
 * Resolver-level precedence is already covered by
 * `tests/profile/resolver.test.ts`; this file exercises the CLI
 * dispatcher (`src/cli/index.ts`) to lock the chain at the
 * boundary the user actually touches.
 *
 * Precedence (lowest → highest):
 *   default(solo) → .autopilot/profile → CLAUDE_AUTOPILOT_PROFILE → --profile
 *
 * `cadence profile show` is the introspection surface — its
 * `Source:` line names which layer won, which is what we assert.
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
  // Strip CLAUDE_AUTOPILOT_PROFILE from inherited env so tests own the
  // env layer. Otherwise a stray export from the shell running
  // `npm test` would shadow the precedence assertions silently.
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-profile-flag-'));
}

function writeProfileFile(cwd: string, contents: string): void {
  const dir = path.join(cwd, '.autopilot');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile'), contents, 'utf8');
}

describe('--profile flag precedence (CLI boundary)', () => {
  it('default → solo (source: default) when no file/env/flag', () => {
    const cwd = mkTempCwd();
    try {
      const r = runCli(['profile', 'show'], { cwd });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /Profile:.*solo/);
      assert.match(r.stdout, /Source:.*default/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('file > default', () => {
    const cwd = mkTempCwd();
    try {
      writeProfileFile(cwd, 'enterprise\n');
      const r = runCli(['profile', 'show'], { cwd });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /Profile:.*enterprise/);
      assert.match(r.stdout, /Source:.*file/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('env > file', () => {
    const cwd = mkTempCwd();
    try {
      writeProfileFile(cwd, 'enterprise\n');
      const r = runCli(['profile', 'show'], {
        cwd,
        env: { CLAUDE_AUTOPILOT_PROFILE: 'small-team' },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /Profile:.*small-team/);
      assert.match(r.stdout, /Source:.*env/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('--profile flag > env > file', () => {
    const cwd = mkTempCwd();
    try {
      writeProfileFile(cwd, 'enterprise\n');
      const r = runCli(['--profile', 'learning', 'profile', 'show'], {
        cwd,
        env: { CLAUDE_AUTOPILOT_PROFILE: 'small-team' },
      });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /Profile:.*learning/);
      assert.match(r.stdout, /Source:.*flag/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('--profile small-team after subcommand also wins', () => {
    // Documented as a global flag — should be parsed regardless of
    // position relative to the subcommand token.
    const cwd = mkTempCwd();
    try {
      const r = runCli(['profile', 'show', '--profile', 'small-team'], { cwd });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /Profile:.*small-team/);
      assert.match(r.stdout, /Source:.*flag/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('--profile "" rejected with typed error (NOT path_traversal)', () => {
    // Acceptance bullet from issue #196: empty flag is unambiguously a
    // CLI mistake; resolver returns parse_error (not path_traversal —
    // see bugbot LOW remediation hint in resolver.ts).
    const cwd = mkTempCwd();
    try {
      const r = runCli(['--profile', '', 'profile', 'show'], { cwd });
      assert.equal(r.code, 1, `expected exit 1; stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /empty value/i);
      assert.doesNotMatch(r.stderr, /path[_-]traversal/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('--profile ../solo rejected as path_traversal', () => {
    const cwd = mkTempCwd();
    try {
      const r = runCli(['--profile', '../solo', 'profile', 'show'], { cwd });
      assert.equal(r.code, 1, `expected exit 1; stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      // Resolver formats this with the regex hint; either the typed
      // code OR the regex pattern in the message satisfies the gate.
      assert.match(r.stderr, /path[_-]traversal|Invalid profile name/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('--profile unknown rejected as unknown', () => {
    const cwd = mkTempCwd();
    try {
      const r = runCli(['--profile', 'mystery', 'profile', 'show'], { cwd });
      assert.equal(r.code, 1, `expected exit 1; stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /Unknown profile|mystery/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('--profile is rejected EARLY for profile-resolution-required commands', () => {
  it('doctor with --profile bogus exits 1 before running checks', () => {
    // doctor is profile-resolution-required (STRICT). Bad name should
    // hard-fail before the prerequisite scan starts.
    const cwd = mkTempCwd();
    try {
      const r = runCli(['--profile', 'bogus', 'doctor'], { cwd });
      assert.equal(r.code, 1, `expected exit 1; stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      // Should be the profile error, not a normal doctor failure
      // (no "blocker(s) — fix before running" line).
      assert.match(r.stderr, /profile error/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('--profile is NOT rejected for profile-resolution-optional commands', () => {
  it('examples succeeds with malformed .autopilot/profile', () => {
    // examples is intentionally NOT in the profile-resolution-required
    // list (acceptance bullet from issue #196 / spec). A broken file
    // must NOT block the spec-printing path.
    const cwd = mkTempCwd();
    try {
      writeProfileFile(cwd, 'two\nlines\n');
      const r = runCli(['examples', 'node'], { cwd });
      assert.equal(r.code, 0, `expected exit 0; stderr: ${r.stderr}`);
      // Spec output starts with a markdown header
      assert.ok(r.stdout.length > 0, 'expected spec body on stdout');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('profile list succeeds with malformed .autopilot/profile', () => {
    const cwd = mkTempCwd();
    try {
      writeProfileFile(cwd, 'two\nlines\n');
      const r = runCli(['profile', 'list'], { cwd });
      assert.equal(r.code, 0, `expected exit 0; stderr: ${r.stderr}`);
      const lines = r.stdout.split('\n').filter(l => l.length > 0);
      assert.ok(lines.length === 5, `expected 5 profiles; got ${lines.length}: ${lines.join(', ')}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
