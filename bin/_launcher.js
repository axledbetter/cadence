// Shared launcher for `cadence`, `claude-autopilot`, and `guardrail` bins.
// Imported, not a bin itself. Resolves tsx, spawns src/cli/index.ts with
// the caller's argv, forwards stdio, exits with the child's status.
//
// v8.0.0 — package renamed @delegance/claude-autopilot → @delegance/cadence.
// `cadence` is the primary bin; `claude-autopilot` and `guardrail` stay as
// aliases through the v8.x line. Env var names (CLAUDE_AUTOPILOT_*) are
// preserved verbatim — renaming them would force another breaking change
// on operators for zero payoff.

import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPILED = path.resolve(__dirname, '..', 'dist', 'src', 'cli', 'index.js');
const SOURCE = path.resolve(__dirname, '..', 'src', 'cli', 'index.ts');

/**
 * Pick the best available entrypoint. Compiled (dist/) is preferred for global
 * installs — no tsx dependency, faster startup. Source+tsx is used in dev from the
 * repo itself. Result determines the spawn strategy below.
 */
function resolveEntry() {
  if (fs.existsSync(COMPILED)) return { kind: 'compiled', path: COMPILED };
  if (fs.existsSync(SOURCE)) return { kind: 'source', path: SOURCE };
  return null;
}

// v7.8.0 — three-tier tsx resolution (project-local → PATH → bundled) with
// a once-per-day deprecation warning on the bundled fallthrough. This is a
// JS port of src/cli/tsx-resolver.ts (which remains the testable source of
// truth used by autoregress, --tsx-source flag handling, and other call
// sites). The launcher can't import the TS resolver directly because it
// runs BEFORE tsx is available, so the two implementations are kept in
// sync by hand. See docs/specs/v7.8.0-decouple-runtime-deps.md.
//
// Escape hatches:
//   --tsx-source=<bundled|project|path>     (parsed from argv, then stripped)
//   CLAUDE_AUTOPILOT_TSX=<bundled|project|path>
//   CLAUDE_AUTOPILOT_NO_TSX_DEPRECATION=1   (silences bundled-fallthrough warning)
const TSX_VALID_SOURCES = ['bundled', 'project', 'path'];

function readTsxFlagOverride(argv) {
  // Find --tsx-source=foo or --tsx-source foo without disturbing other argv
  // (we surface "invalid value" diagnostics from the CLI's own arg parser
  // when it sees the still-present flag — only strip and use it here).
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith('--tsx-source=')) {
      const v = a.slice('--tsx-source='.length);
      return TSX_VALID_SOURCES.includes(v) ? v : null;
    }
    if (a === '--tsx-source' && i + 1 < argv.length) {
      const v = argv[i + 1];
      return TSX_VALID_SOURCES.includes(v) ? v : null;
    }
  }
  return null;
}

function bundledTsxPath() {
  // Our own bundled tsx — relative to the package root (two levels up from bin/).
  const p = path.resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');
  return fs.existsSync(p) ? p : null;
}
function projectLocalTsxPath() {
  // Consumer project — when installed as a dep, npm hoists peer bins to
  // <consumer>/node_modules/.bin/tsx. ONLY classify as project-local if
  // the consumer EXPLICITLY declared tsx in their package.json. Without
  // this gate, npm's hoisting of our own bundled tsx would be mislabeled
  // as project-local, suppressing the deprecation warning that drives
  // the v8.0.0 migration.
  //
  // Layout when installed as a dep:
  //   <consumer>/package.json
  //   <consumer>/node_modules/@delegance/claude-autopilot/bin/_launcher.js   <-- __dirname/..
  //   <consumer>/node_modules/.bin/tsx
  // So the consumer package root is four dirs up from bin/.
  const consumerPkgRoot = path.resolve(__dirname, '..', '..', '..', '..');
  if (!consumerDeclaresTsx(consumerPkgRoot)) return null;
  const p = path.resolve(__dirname, '..', '..', '..', '.bin', 'tsx');
  return fs.existsSync(p) ? p : null;
}

/**
 * True iff the consumer's `package.json` declares `tsx` in dependencies,
 * devDependencies, or peerDependencies. Mirrors the TS resolver's
 * `consumerDeclaresTsx` — see src/cli/tsx-resolver.ts. Missing or
 * malformed package.json → false (conservative: better to fall through
 * to PATH/bundled than to mislabel hoisted deps as project-local).
 */
function consumerDeclaresTsx(consumerPkgRoot) {
  try {
    const pkgPath = path.join(consumerPkgRoot, 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    const dd = (pkg && pkg.dependencies) || {};
    const ddv = (pkg && pkg.devDependencies) || {};
    const pd = (pkg && pkg.peerDependencies) || {};
    return 'tsx' in dd || 'tsx' in ddv || 'tsx' in pd;
  } catch {
    return false;
  }
}
function pathTsxPath() {
  const PATH = process.env.PATH || process.env.Path || '';
  if (!PATH) return null;
  const isWin = process.platform === 'win32';
  const sep = isWin ? ';' : ':';
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const bundled = bundledTsxPath();
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    // Windows NTFS is case-insensitive — `tsx.cmd`, `TSX.CMD`, `Tsx.Cmd` all
    // resolve to the same file. Use a case-insensitive readdir match instead
    // of existsSync(tsx + ext), which mismatches when on-disk filename casing
    // differs from PATHEXT casing.
    const cand = isWin
      ? findTsxCaseInsensitive(dir, exts)
      : (() => {
          const c = path.join(dir, 'tsx');
          return fs.existsSync(c) ? c : null;
        })();
    if (!cand) continue;
    // A3 self-pointer: if PATH-resolved bin's package root is OUR own
    // bundled tsx package root, skip this candidate and keep searching.
    // npm prepends `node_modules/.bin` to PATH for `npm run`, so the
    // bundled-pointing entry is typically hit first. `return null` here
    // would abort the whole PATH search and hide a user's globally-
    // installed tsx later in PATH. `continue` instead — if no other PATH
    // entry hits, the loop falls off the end and the caller falls
    // through to bundled with the deprecation warning.
    if (isInBundledPackage(cand, bundled)) {
      continue;
    }
    // On Windows, `.cmd`/`.bat` shims can't be executed directly by
    // spawn() — callers must pass `shell: true`. Mark the resolution
    // with the metadata they need.
    if (isWin && /\.(cmd|bat)$/i.test(cand)) {
      return { path: cand, shell: true };
    }
    return cand;
  }
  return null;
}

/**
 * Case-insensitive lookup for `tsx` + each PATHEXT entry inside `dir`.
 * Mirrors src/cli/tsx-resolver.ts findTsxCaseInsensitive(). Returns the
 * actual on-disk filename joined onto `dir`, or null if no match.
 */
function findTsxCaseInsensitive(dir, exts) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const wanted = new Set(exts.map((ext) => `tsx${ext}`.toLowerCase()));
  for (const entry of entries) {
    if (wanted.has(entry.toLowerCase())) {
      return path.join(dir, entry);
    }
  }
  return null;
}

/**
 * True iff `candidatePath` resolves into our bundled tsx package directory
 * (after realpath). `bundled` is the path to our own `node_modules/.bin/tsx`
 * (or null if it can't be located). We compare PACKAGE ROOTS — `node_modules/
 * tsx/` — not bin dirs, since `.bin/tsx` and `tsx/dist/cli.mjs` live in
 * different directories.
 */
function isInBundledPackage(candidatePath, bundled) {
  if (!bundled) return false;
  try {
    const realCandidate = fs.realpathSync(candidatePath);
    const realBundled = fs.realpathSync(bundled);
    // realBundled now points at the real tsx entry (e.g. .../node_modules/
    // tsx/dist/cli.mjs on Unix, or remains the .cmd shim on Windows). Walk
    // up to the tsx package root.
    const bundledPkgRoot = packageRootContaining(realBundled);
    if (!bundledPkgRoot) return false;
    return realCandidate.startsWith(bundledPkgRoot + path.sep) || realCandidate === bundledPkgRoot;
  } catch {
    return false;
  }
}

/**
 * Walk upward from a file path looking for `node_modules/tsx`. Returns the
 * absolute path to the tsx package root, or null if not found within 5 levels.
 *
 * PARITY: keep in sync with src/cli/tsx-resolver.ts packageRootContaining().
 * The TS version is parameterized over `pkgName`; this launcher copy is
 * specialized to `tsx` since the launcher only resolves tsx.
 */
function packageRootContaining(filePath) {
  let dir = path.dirname(filePath);
  for (let i = 0; i < 6; i += 1) {
    const base = path.basename(dir);
    if (base === 'tsx' && path.basename(path.dirname(dir)) === 'node_modules') {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function stateDir() {
  if (process.env.CLAUDE_AUTOPILOT_STATE_DIR) return process.env.CLAUDE_AUTOPILOT_STATE_DIR;
  if (process.platform !== 'win32' && process.env.XDG_STATE_HOME) {
    return path.join(process.env.XDG_STATE_HOME, 'claude-autopilot');
  }
  return path.join(os.homedir(), '.claude-autopilot');
}

const TSX_DEPRECATION_MESSAGE =
  '\n' +
  '[deprecation] @delegance/cadence is using its bundled `tsx` to run\n' +
  '              your TypeScript scripts. In a future major, `tsx` will be removed\n' +
  '              from runtime deps and you will need to install it yourself:\n' +
  '\n' +
  '                  npm install -D tsx\n' +
  '\n' +
  '              To silence this warning now and prepare for the next major:\n' +
  '                1. Add `tsx` to your project devDependencies, OR\n' +
  '                2. Set `CLAUDE_AUTOPILOT_NO_TSX_DEPRECATION=1` in your env.\n' +
  '\n' +
  '              Override resolution: `CLAUDE_AUTOPILOT_TSX=bundled|project|path`\n' +
  '              See docs/specs/v7.8.0-decouple-runtime-deps.md for details.\n';

function emitTsxDeprecationWarningSafe() {
  if (process.env.CLAUDE_AUTOPILOT_NO_TSX_DEPRECATION === '1') return;
  const today = new Date().toISOString().slice(0, 10);
  const dedupPath = path.join(stateDir(), '.tsx-deprecation-shown');
  try {
    if (fs.existsSync(dedupPath)) {
      const lastShown = fs.readFileSync(dedupPath, 'utf8').trim();
      if (lastShown === today) return;
    }
  } catch { /* unreadable — fall through and print */ }
  try {
    fs.mkdirSync(path.dirname(dedupPath), { recursive: true });
    fs.writeFileSync(dedupPath, today);
  } catch { /* non-fatal */ }
  process.stderr.write(TSX_DEPRECATION_MESSAGE);
}

/**
 * Resolve a tsx executable using the v7.8.0 precedence ladder. Returns
 * `{path, shell?}`. Honors --tsx-source / CLAUDE_AUTOPILOT_TSX overrides,
 * with --tsx-source taking priority. On bundled fallthrough (no override),
 * emits the once-per-day deprecation warning unless silenced.
 *
 * Forced overrides MUST fail fast: if the user explicitly asked for a
 * source and it can't be resolved, exit 2 with an actionable stderr message.
 * Silently falling back to a global `tsx` was a footgun — the user has no
 * indication their override was ignored.
 */
function findTsx() {
  const flagOverride = readTsxFlagOverride(process.argv.slice(2));
  const envOverride = process.env.CLAUDE_AUTOPILOT_TSX;
  const override = flagOverride
    || (TSX_VALID_SOURCES.includes(envOverride) ? envOverride : null);
  const forcedBy = flagOverride ? '--tsx-source' : (override ? 'CLAUDE_AUTOPILOT_TSX' : null);

  if (override === 'project') {
    const p = projectLocalTsxPath();
    if (!p) {
      process.stderr.write(
        `[cadence] Error: ${forcedBy}=project requested but no project-local tsx found.\n` +
        '  Install tsx in your project: npm install -D tsx\n' +
        '  Or unset the override.\n',
      );
      process.exit(2);
    }
    return toResolution(p);
  }
  if (override === 'path') {
    const p = pathTsxPath();
    if (!p) {
      process.stderr.write(
        `[cadence] Error: ${forcedBy}=path requested but no tsx found on PATH.\n` +
        '  Install tsx globally (npm install -g tsx) or unset the override.\n',
      );
      process.exit(2);
    }
    return toResolution(p);
  }
  if (override === 'bundled') {
    const p = bundledTsxPath();
    if (!p) {
      process.stderr.write(
        `[cadence] Error: ${forcedBy}=bundled requested but the bundled tsx is missing.\n` +
        '  Reinstall @delegance/cadence or unset the override.\n',
      );
      process.exit(2);
    }
    return toResolution(p);
  }

  // Default precedence: project → PATH → bundled (with deprecation warning).
  const project = projectLocalTsxPath();
  if (project) return toResolution(project);
  const fromPath = pathTsxPath();
  if (fromPath) return toResolution(fromPath);
  emitTsxDeprecationWarningSafe();
  const bundled = bundledTsxPath();
  if (!bundled) {
    process.stderr.write(
      '[cadence] Error: bundled tsx is missing — reinstall @delegance/cadence.\n',
    );
    process.exit(2);
  }
  return toResolution(bundled);
}

/**
 * Normalize the result of a tsx-path lookup into a `{path, shell?}`
 * resolution. `pathTsxPath()` may return either a string or an object with
 * `{path, shell}` for `.cmd`/`.bat` shims that require `shell: true`.
 */
function toResolution(value) {
  if (typeof value === 'string') return { path: value };
  return value;
}

// v7.1.7 — Per-calendar-day deprecation dedup, keyed in the user's home dir.
//
// The previous (v6.3+) implementation used a temp file keyed by `process.ppid
// + stderr.isTTY` to dedup once per "terminal session." That worked in
// interactive shells but FAILED for the most common deprecation trigger —
// the pre-commit/pre-push git hooks. Git spawns a fresh shell for each hook
// invocation, so the parent PID is fresh on every commit, the stamp file
// path is unique each time, and the notice printed on every single commit.
// The v7.1.6 blank-repo benchmark agent surfaced this as the #1 paper cut.
//
// New strategy: stamp at `~/.claude-autopilot/.deprecation-shown`, contents =
// `YYYY-MM-DD` (UTC). Show at most once per day per machine. Operator gets a
// daily reminder of the rename without per-commit spam. Override env vars
// (`CLAUDE_AUTOPILOT_DEPRECATION=always|never`) preserved.
const DEPRECATION_STAMP_PATH = path.join(os.homedir(), '.claude-autopilot', '.deprecation-shown');
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}
function hasShownDeprecationToday() {
  try {
    if (!fs.existsSync(DEPRECATION_STAMP_PATH)) return false;
    return fs.readFileSync(DEPRECATION_STAMP_PATH, 'utf8').trim() === todayUtc();
  } catch {
    // Stamp unreadable — show notice (better than silently swallowing).
    return false;
  }
}
function markDeprecationShown() {
  try {
    const dir = path.dirname(DEPRECATION_STAMP_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DEPRECATION_STAMP_PATH, todayUtc());
  } catch { /* best-effort; missing stamp re-prints next invocation */ }
}

/**
 * Decide whether to emit the deprecation notice. Order:
 *   CLAUDE_AUTOPILOT_DEPRECATION=never   → never emit (CI/automation)
 *   CLAUDE_AUTOPILOT_DEPRECATION=always  → always emit (deterministic testing)
 *   otherwise                            → at most once per UTC day
 */
function shouldEmitDeprecation() {
  const override = process.env.CLAUDE_AUTOPILOT_DEPRECATION;
  if (override === 'never') return false;
  if (override === 'always') return true;
  return !hasShownDeprecationToday();
}

/**
 * Launch the CLI with `argv` passed through verbatim.
 * @param {{ name: 'cadence' | 'claude-autopilot' | 'guardrail' }} opts
 */
export function launch(opts) {
  if (opts.name === 'guardrail' && shouldEmitDeprecation()) {
    process.stderr.write(
      '\x1b[33m[deprecated]\x1b[0m `guardrail` CLI is renamed to `claude-autopilot`. ' +
      'The `guardrail` alias works through v5.x and will be removed in v6. ' +
      'Migration guide: https://github.com/axledbetter/claude-autopilot/blob/master/docs/migration/v4-to-v5.md\n' +
      'Silence: set CLAUDE_AUTOPILOT_DEPRECATION=never\n',
    );
    // v7.1.7 — mark stamp AFTER successful emission so a write-failure on
    // stderr still results in the next invocation re-trying. Skip when
    // CLAUDE_AUTOPILOT_DEPRECATION=always (deterministic-testing override
    // shouldn't write the stamp).
    if (process.env.CLAUDE_AUTOPILOT_DEPRECATION !== 'always') {
      markDeprecationShown();
    }
  }

  const entry = resolveEntry();
  if (!entry) {
    process.stderr.write(
      '[cadence] Could not find CLI entrypoint. Expected either\n' +
      `  ${COMPILED} (compiled) or\n` +
      `  ${SOURCE} (source)\n` +
      'Reinstall: npm install -g @delegance/cadence@latest\n',
    );
    process.exit(127);
  }

  let result;
  if (entry.kind === 'compiled') {
    // Fast path — plain node, no tsx dep. Used by global installs (ships dist/).
    result = spawnSync(process.execPath, [entry.path, ...process.argv.slice(2)], { stdio: 'inherit' });
  } else {
    // Dev path — run source via tsx. Used from the repo itself, or by users who
    // installed from git or linked a local copy.
    //
    // On Windows, PATH-resolved `.cmd`/`.bat` shims must be spawned with
    // `shell: true` — Node's exec syscalls can't launch them directly.
    // Bundled / project-local hits run as bare JS via node and don't need
    // a shell. The resolver tells us which mode to use.
    const tsx = findTsx();
    const spawnOpts = { stdio: 'inherit' };
    if (tsx.shell) spawnOpts.shell = true;
    result = spawnSync(tsx.path, [entry.path, ...process.argv.slice(2)], spawnOpts);
  }

  if (result.error) {
    // ENOENT or similar spawn failure — surface cleanly instead of hanging.
    process.stderr.write(`[cadence] Failed to launch CLI: ${result.error.message}\n`);
    process.exit(127);
  }
  if (result.signal) {
    // Forward child signal by re-raising equivalently
    process.kill(process.pid, result.signal);
    return;
  }
  process.exit(result.status ?? 1);
}
