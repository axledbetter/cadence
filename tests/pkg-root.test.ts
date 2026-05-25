import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageRoot, resolveSiblingModule } from '../src/cli/_pkg-root.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('findPackageRoot', () => {
  it('finds the @delegance/cadence package root from the source caller', () => {
    const root = findPackageRoot(import.meta.url);
    // The test itself lives at <root>/tests/pkg-root.test.ts
    assert.equal(root, ROOT);
  });

  it('returns null when caller is outside the package tree', () => {
    // /tmp is not inside the package tree
    const root = findPackageRoot('file:///tmp/unrelated/foo.js');
    assert.equal(root, null);
  });

  // Regression: real-world soak found that compiled `dist/src/cli/setup.js`
  // resolved `../../presets/...` to `dist/presets/` (which doesn't exist).
  // After alpha.4, `findPackageRoot` walks up from any caller and lands on the
  // package root regardless of source vs compiled layout.
  it('finds the package root when called from a synthesized compiled-output location', () => {
    // Build the package's own compiled output and verify the helper resolves
    // back up out of dist/.
    const distFile = path.join(ROOT, 'dist', 'src', 'cli', 'index.js');
    if (!fs.existsSync(distFile)) {
      // Skip cleanly if dist hasn't been built — this test is meaningful only
      // when we have compiled output to validate. In CI, `npm run build`
      // happens before `npm test` for some flows; locally `npm run typecheck`
      // does not. Note rather than fail.
      return;
    }
    // Fake a caller URL pointing at the compiled file
    const callerUrl = new URL('file:' + distFile).href;
    const root = findPackageRoot(callerUrl);
    assert.equal(root, ROOT, `compiled caller must walk up out of dist/ to package root; got ${root}`);
  });
});

describe('resolveSiblingModule', () => {
  it('keeps .ts extension when caller is a .ts source file', () => {
    const callerUrl = 'file:///repo/src/foo/bar.ts';
    const resolved = resolveSiblingModule('./baz.ts', callerUrl);
    assert.match(resolved, /baz\.ts$/);
  });

  it('rewrites .ts → .js when caller is a .js compiled file', () => {
    const callerUrl = 'file:///repo/dist/src/foo/bar.js';
    const resolved = resolveSiblingModule('./baz.ts', callerUrl);
    assert.match(resolved, /baz\.js$/);
  });

  it('rewrites .ts → .js when caller is a .mjs file', () => {
    const callerUrl = 'file:///repo/dist/src/foo/bar.mjs';
    const resolved = resolveSiblingModule('./baz.ts', callerUrl);
    assert.match(resolved, /baz\.js$/);
  });

  // Regression: alpha.4's `npx @alpha scan --all` failed with "Failed to import
  // adapter from .../auto.ts" because the adapter loader's BUILTIN_PATHS map
  // hardcodes `.ts` extensions, but compiled output has `.js`. resolveSiblingModule
  // closes the gap.
  it('handles nested relative refs (../parent/file.ts)', () => {
    const callerUrl = 'file:///repo/dist/src/adapters/loader.js';
    const resolved = resolveSiblingModule('./review-engine/auto.ts', callerUrl);
    assert.equal(resolved, '/repo/dist/src/adapters/review-engine/auto.js');
  });
});

describe('static-rule registry resolves under compiled layout', () => {
  it('loadRulesFromConfig successfully imports built-in rules under compiled output', async () => {
    const distEntry = path.join(ROOT, 'dist', 'src', 'core', 'static-rules', 'registry.js');
    if (!fs.existsSync(distEntry)) return; // skip when dist hasn't been built

    // Spawn a child node process to import the compiled registry and load a
    // representative rule. Verifies the dynamic-import string in registry.js
    // resolves correctly (catches the alpha.4 → alpha.5 bug class).
    const probe = `
      import('${distEntry}').then(m => m.loadRulesFromConfig(['hardcoded-secrets']))
        .then(rules => { if (rules.length === 1 && rules[0].name === 'hardcoded-secrets') process.exit(0); else process.exit(2); })
        .catch(e => { console.error(e.message); process.exit(3); });
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(r.status, 0, `compiled registry import failed: ${r.stderr}`);
  });
});

describe('init --preset generic resolves preset config from compiled layout', () => {
  it('writes guardrail.config.yaml when invoked from a fresh project against the compiled bundle', () => {
    const distEntry = path.join(ROOT, 'dist', 'src', 'cli', 'index.js');
    if (!fs.existsSync(distEntry)) {
      // Build hasn't happened — skip this regression test (the unit test above
      // covers the helper function directly). Note rather than fail.
      return;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-init-smoke-'));
    try {
      // Seed a minimal package.json so detector falls back to `generic`
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'init-smoke-fixture',
        version: '0.0.0',
        scripts: { test: 'echo' },
      }));

      const r = spawnSync(process.execPath, [distEntry, 'init', '--preset', 'generic'], {
        cwd: tmp,
        encoding: 'utf8',
        timeout: 15_000,
        // init may read stdin for prompt; closing it keeps the test deterministic
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      assert.equal(r.status, 0, `init exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.ok(
        fs.existsSync(path.join(tmp, 'guardrail.config.yaml')),
        `init must write guardrail.config.yaml; cwd contents: ${fs.readdirSync(tmp).join(', ')}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
