#!/usr/bin/env node
/**
 * Tombstone bin for @delegance/guardrail@5.0.0+.
 *
 * @delegance/guardrail was renamed to @delegance/claude-autopilot in v5. Users
 * still pinned to @delegance/guardrail install this thin wrapper, which forwards
 * argv to the new package with strict stdio + exit-code + signal passthrough.
 *
 * Resolution strategy (per Codex review of alpha.3 spec):
 *   1. node module resolution via createRequire — works across npm/pnpm/yarn/PnP
 *   2. relative probe of sibling node_modules — fallback when require fails
 *   3. PATH lookup of `claude-autopilot` — last-resort safety net
 *
 * No behavioral interpretation — every byte the child writes is forwarded.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEPRECATION_NOTICE =
  '\x1b[33m[deprecated]\x1b[0m @delegance/guardrail was renamed to @delegance/cadence ' +
  '(formerly @delegance/claude-autopilot — also deprecated as of v8.0.0). ' +
  'This package is a thin forwarding wrapper — identical behavior. ' +
  'Migrate: npm install @delegance/cadence && npx cadence migrate-v4 --write\n' +
  'Silence: set CLAUDE_AUTOPILOT_DEPRECATION=never\n';

function resolveClaudeAutopilotBin() {
  const req = createRequire(import.meta.url);

  // v8.0.0 — the package was renamed @delegance/claude-autopilot →
  // @delegance/cadence. Try the new name first, fall back to the legacy
  // name so users on older installs keep working.
  const PKG_CANDIDATES = ['@delegance/cadence', '@delegance/claude-autopilot'];
  const BIN_NAMES = ['cadence.js', 'claude-autopilot.js'];

  // Strategy 1: resolve the entrypoint directly. Works when the main package
  // declares `./bin/<name>.js` in its `exports` field. (cadence ships
  // both ./bin/cadence.js and ./bin/claude-autopilot.js as of v8.0.0.)
  for (const pkg of PKG_CANDIDATES) {
    for (const bin of BIN_NAMES) {
      try {
        return req.resolve(`${pkg}/bin/${bin}`);
      } catch { /* fall through */ }
    }
  }

  // Strategy 2: resolve each candidate's package.json (always exposed by
  // node's resolver even when `exports` is restrictive) and derive the bin
  // path from it. Works under npm, pnpm, yarn classic hoisted, yarn PnP,
  // Deno's npm compat layer.
  for (const pkg of PKG_CANDIDATES) {
    try {
      const pkgJson = req.resolve(`${pkg}/package.json`);
      const pkgDir = path.dirname(pkgJson);
      for (const bin of BIN_NAMES) {
        const candidate = path.join(pkgDir, 'bin', bin);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch { /* fall through */ }
  }

  // Strategy 3: relative probe of sibling node_modules layouts (when the
  // tombstone is installed globally next to the real package without either
  // being resolvable via the module graph). Probe both legacy and new
  // package names + both bin names.
  const probeRoots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', '..'),
    path.resolve(__dirname, '..', '..', '..'),
  ];
  for (const root of probeRoots) {
    for (const pkgPath of ['@delegance/cadence', '@delegance/claude-autopilot']) {
      for (const bin of BIN_NAMES) {
        const candidate = path.join(root, pkgPath, 'bin', bin);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }

  // Strategy 4: PATH lookup of the co-installed bin.
  return null;
}

if (process.env.CLAUDE_AUTOPILOT_DEPRECATION !== 'never') {
  process.stderr.write(DEPRECATION_NOTICE);
}

const resolved = resolveClaudeAutopilotBin();
let result;
if (resolved) {
  // Spawn node directly on the resolved entrypoint — avoids bin-shim quirks on
  // Windows and under npm/yarn wrappers. process.execPath is the current node.
  result = spawnSync(process.execPath, [resolved, ...process.argv.slice(2)], { stdio: 'inherit' });
} else {
  // Last resort: shell out to `cadence` (preferred) then `claude-autopilot` on PATH.
  result = spawnSync('cadence', process.argv.slice(2), { stdio: 'inherit' });
  if (result.error && result.error.code === 'ENOENT') {
    result = spawnSync('claude-autopilot', process.argv.slice(2), { stdio: 'inherit' });
  }
}

if (result.error) {
  if (result.error.code === 'ENOENT') {
    process.stderr.write(
      '[guardrail] @delegance/cadence not found. Install it:\n' +
      '  npm install -g @delegance/cadence\n' +
      'Or add it as a sibling dep of @delegance/guardrail in your project.\n',
    );
    process.exit(127);
  }
  process.stderr.write(`[guardrail] Launch failed: ${result.error.message}\n`);
  process.exit(127);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status ?? 1);
}
