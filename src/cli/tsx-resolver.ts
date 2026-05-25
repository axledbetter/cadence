// src/cli/tsx-resolver.ts
//
// Cross-platform tsx resolver used by the CLI launcher when the dev/source
// path is taken (running .ts files via `node --import tsx`). Returns a
// `{command, args, source}` triple so spawning is portable (Windows uses
// `.cmd` shims; spawn via process.execPath + the resolved JS entry to avoid
// shebang / PATHEXT quirks).
//
// Precedence (default):
//   1. project-local — <projectRoot>/node_modules/tsx (via createRequire)
//   2. PATH — hand-rolled cross-platform lookup (no `which` dep)
//   3. bundled — this package's own bundled tsx (with a once-per-day
//      deprecation warning; tsx is scheduled to be removed from runtime
//      deps in v8.0.0).
//
// Escape hatches (in priority order, both skip precedence):
//   --tsx-source=<bundled|project|path>     (CLI flag, "forcedBy: flag")
//   CLAUDE_AUTOPILOT_TSX=<bundled|project|path>  (env, "forcedBy: env")
//
// Deprecation warning is silenced by CLAUDE_AUTOPILOT_NO_TSX_DEPRECATION=1.
// Filesystem dedup writes (state dir) are non-fatal — even if the state
// dir can't be created, the warning still prints (intentional: readonly
// homedir in CI should not change semantics).
//
// Amendments from codex pass 2 wired in:
//   A1 — `createRequire(import.meta.url)` at module scope (ESM-safe)
//   A3 — PATH-resolved bin that lives inside our own node_modules is
//        treated as `bundled` so the warning still fires
//   A6 — hand-rolled PATH lookup (drops the `which` dep)
//   A7 — XDG_STATE_HOME / CLAUDE_AUTOPILOT_STATE_DIR for warning dedup

import { createRequire } from 'node:module';
import { existsSync, readFileSync, mkdirSync, writeFileSync, realpathSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A1: createRequire at module scope so `require.resolve('tsx/package.json')`
// works in ESM-compiled output (the package is `"type": "module"`).
const require = createRequire(import.meta.url);

export type TsxSource = 'project-local' | 'path' | 'bundled';

export interface TsxResolution {
  /** Command to spawn (absolute path, normally `process.execPath`). */
  command: string;
  /** Args prepended before the user script path. */
  args: string[];
  /** Where tsx came from — drives the deprecation warning. */
  source: TsxSource;
  /** Override origin if env var or CLI flag forced this resolution. */
  forcedBy?: 'env' | 'flag';
  /**
   * If true, callers MUST spawn this resolution with `shell: true` (or via
   * cmd.exe). Set on Windows PATH hits that resolve to a `.cmd`/`.bat` shim —
   * Node's `spawn()` cannot execute those reliably without a shell.
   * Bundled / project-local hits run `process.execPath <bin.js>` directly and
   * don't need a shell.
   */
  shell?: boolean;
}

export interface ResolveOpts {
  projectRoot: string;
  /** Value of CLAUDE_AUTOPILOT_TSX env var, if set. */
  envOverride?: string;
  /** Value of --tsx-source CLI flag, if passed. */
  flagOverride?: 'bundled' | 'project' | 'path';
  /** Test helper — suppress deprecation warning even on bundled fallthrough. */
  suppressWarning?: boolean;
  /** Test helper — inject process.env (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Test helper — inject process.platform (defaults to process.platform). */
  platform?: NodeJS.Platform;
}

const VALID_SOURCES: ReadonlyArray<'bundled' | 'project' | 'path'> = [
  'bundled',
  'project',
  'path',
];

export function resolveTsx(opts: ResolveOpts): TsxResolution {
  const { projectRoot, envOverride, flagOverride } = opts;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;

  // --- Escape hatch: --tsx-source flag (highest priority) ---
  if (flagOverride) {
    return resolveFromSource(flagOverride, projectRoot, 'flag', { env, platform });
  }

  // --- Escape hatch: CLAUDE_AUTOPILOT_TSX env var ---
  if (envOverride && (VALID_SOURCES as readonly string[]).includes(envOverride)) {
    return resolveFromSource(envOverride as 'bundled' | 'project' | 'path', projectRoot, 'env', { env, platform });
  }

  // --- Normal precedence ladder ---
  const projectResolved = tryProjectLocal(projectRoot);
  if (projectResolved) return projectResolved;

  const pathResolved = tryPath({ env, platform });
  if (pathResolved) return pathResolved;

  // Fall back to bundled tsx + (maybe) deprecation warning.
  const bundled = resolveBundled();
  if (!opts.suppressWarning) {
    emitTsxDeprecationWarningSafe({ env, platform });
  }
  return bundled;
}

function tryProjectLocal(projectRoot: string): TsxResolution | null {
  // Only classify as "project-local" if the CONSUMER explicitly declared
  // `tsx` in their package.json. npm hoists @delegance/cadence's
  // own tsx dep to the consumer root `node_modules/tsx`, so a bare
  // `require.resolve('tsx/package.json')` from the consumer root would
  // succeed even when the consumer never declared tsx themselves. Without
  // this gate we mislabel the hoisted bundled tsx as project-local,
  // suppressing the deprecation warning that's supposed to drive the
  // v8.0.0 migration.
  if (!consumerDeclaresTsx(projectRoot)) return null;
  try {
    const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
    const pkgPath = projectRequire.resolve('tsx/package.json');
    return buildResolutionFromPkgJson(pkgPath, 'project-local');
  } catch {
    return null;
  }
}

/**
 * Reads the consumer's `package.json` and returns true iff `tsx` appears in
 * `dependencies`, `devDependencies`, or `peerDependencies`. Missing or
 * malformed package.json → false (conservative: better to fall through to
 * PATH/bundled than to silently mislabel hoisted deps as project-local).
 */
function consumerDeclaresTsx(projectRoot: string): boolean {
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      peerDependencies?: Record<string, unknown>;
    };
    return (
      !!pkg.dependencies && 'tsx' in pkg.dependencies
        ? true
        : !!pkg.devDependencies && 'tsx' in pkg.devDependencies
          ? true
          : !!pkg.peerDependencies && 'tsx' in pkg.peerDependencies
    );
  } catch {
    return false;
  }
}

interface PathLookupOpts {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

/**
 * Walk upward from `filePath` looking for `<dir>/node_modules/<pkgName>`.
 * Returns the absolute path to the package root, or null if not found.
 *
 * Used by the A3 self-pointer guard. Replaces the previous hardcoded
 * `path.dirname(path.dirname(binAbs))` walk which assumed tsx's bin lived
 * exactly 2 directories deep inside its package — fragile when tsx ships
 * its bin at `dist/cli.mjs` (3 deep) or future layouts.
 *
 * PARITY: keep in sync with bin/_launcher.js packageRootContaining().
 */
function packageRootContaining(filePath: string, pkgName: string): string | null {
  let dir = path.dirname(path.resolve(filePath));
  while (dir !== path.dirname(dir)) {
    if (path.basename(dir) === pkgName && path.basename(path.dirname(dir)) === 'node_modules') {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Case-insensitive lookup for `tsx` + each PATHEXT entry inside `dir`.
 * Real Windows NTFS is case-insensitive, so `tsx.cmd`, `TSX.CMD`, and
 * `Tsx.Cmd` all resolve to the same file. Linux ext4 (and most CI
 * containers) is case-sensitive, so the previous `existsSync(tsx + ext)`
 * lookup mismatched when test fixtures wrote `tsx.cmd` (lowercase) and
 * PATHEXT was iterated in uppercase form (`.CMD`).
 *
 * Returns the actual filename found in `dir` (with on-disk casing) joined
 * onto `dir`, or null if no match.
 */
function findTsxCaseInsensitive(dir: string, exts: ReadonlyArray<string>): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  // Build set of acceptable lowercase filenames: `tsx`, `tsx.exe`, `tsx.cmd`, ...
  const wanted = new Set(exts.map((ext) => `tsx${ext}`.toLowerCase()));
  for (const entry of entries) {
    if (wanted.has(entry.toLowerCase())) {
      return path.join(dir, entry);
    }
  }
  return null;
}

/**
 * Hand-rolled PATH lookup (A6 — drops the `which` dep). On Windows, walk
 * PATHEXT for each entry with a case-insensitive filename match; on POSIX,
 * look for the bare `tsx` filename (case-sensitive).
 */
function tryPath(opts: PathLookupOpts): TsxResolution | null {
  const PATH = opts.env.PATH ?? opts.env.Path ?? '';
  if (!PATH) return null;

  const isWin = opts.platform === 'win32';
  const PATHEXT = isWin
    ? (opts.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const sep = isWin ? ';' : ':';

  // A3 prep: figure out our bundled tsx package ROOT so we can detect a
  // PATH entry that actually points back at our own node_modules. The
  // previous implementation compared bin-dir prefixes (e.g.
  // `node_modules/tsx/dist/`), but PATH hits are typically
  // `node_modules/.bin/tsx` — a symlink (Unix) or `.cmd` shim (Windows)
  // that lives in a SIBLING directory. `startsWith()` never matched.
  // Compare package roots after `realpathSync` resolves the symlink/shim
  // back to the underlying tsx package.
  let bundledPkgRoot: string | null = null;
  try {
    const bundled = resolveBundled();
    // `bundled.args[0]` is the absolute path to tsx's bin (e.g.
    // `node_modules/tsx/dist/cli.mjs`). Walk upward to find the tsx
    // package root rather than assuming a fixed depth — the previous
    // `path.dirname(path.dirname(binAbs))` baked in 2 levels and broke
    // on layouts where the bin lives 3+ directories deep inside the pkg.
    const binAbs = bundled.args[0] ?? '';
    if (binAbs) {
      bundledPkgRoot = packageRootContaining(binAbs, 'tsx');
    }
  } catch {
    // If we can't even resolve the bundled tsx (shouldn't happen — it's a
    // dep), continue without the self-pointer guard. The worst case is we
    // miss the warning on a corner-case install.
    bundledPkgRoot = null;
  }

  for (const rawDir of PATH.split(sep)) {
    const dir = rawDir.trim();
    if (!dir) continue;
    // On Windows, NTFS is case-insensitive — match filename case-insensitively
    // against PATHEXT. On POSIX, ext4/btrfs are case-sensitive and PATHEXT is
    // a single empty string, so the case-sensitive existsSync path is fine.
    const candidate = isWin
      ? findTsxCaseInsensitive(dir, PATHEXT)
      : (() => {
          const c = path.join(dir, 'tsx');
          return existsSync(c) ? c : null;
        })();
    if (!candidate) continue;

    // A3 — PATH hit that is actually inside our bundled node_modules
    // is not really "user-supplied tsx on PATH"; skip this candidate and
    // keep searching subsequent PATH entries. If no real user tsx exists
    // anywhere on PATH, the loop falls off the end and the caller
    // (resolveTsx) falls through to bundled with the deprecation warning.
    //
    // Critical: this MUST be `continue`, not `return null`. npm prepends
    // `node_modules/.bin` to PATH when running scripts, so the bundled-
    // pointing entry is hit first. A `return null` here would abort the
    // entire PATH search, hiding a user's globally-installed tsx that
    // appears later in PATH and triggering a spurious deprecation warning.
    //
    // Resolve symlinks via realpath because `node_modules/.bin/tsx` is
    // typically a symlink to `../tsx/dist/cli.mjs` on Unix (and a .cmd
    // shim on Windows that textually references the package directory).
    if (bundledPkgRoot && isInBundledPackageRoot(candidate, bundledPkgRoot)) {
      continue;
    }

    // For a PATH-resolved bin, spawn it directly. On Windows the .cmd
    // shim handles dispatching to node; on Unix the shebang does.
    //
    // Critical: Node's `spawn()` on Windows cannot launch `.cmd`/`.bat`
    // files directly — the OS exec syscalls require `cmd.exe`. Mark
    // those hits so callers pass `shell: true` to `spawn()`. POSIX
    // shebang hits don't need a shell.
    const needsShell =
      isWin && /\.(cmd|bat)$/i.test(candidate);
    return {
      command: candidate,
      args: [],
      source: 'path',
      ...(needsShell ? { shell: true } : {}),
    };
  }
  return null;
}

function resolveBundled(): TsxResolution {
  const pkgPath = require.resolve('tsx/package.json');
  return buildResolutionFromPkgJson(pkgPath, 'bundled');
}

/**
 * True iff `candidatePath`, after realpath, lives inside `bundledPkgRoot`.
 * Used by the A3 self-pointer guard. PATH hits typically resolve to
 * `node_modules/.bin/tsx`, which is a SYMLINK (Unix) or `.cmd` shim
 * (Windows) pointing into the tsx package. realpathSync resolves the
 * symlink to the real entry under `node_modules/tsx/...`, so the
 * package-root prefix check succeeds. Without realpath, `.bin/tsx` and
 * `tsx/dist/cli.mjs` are in different directories and the previous
 * `startsWith()` comparison silently failed.
 */
function isInBundledPackageRoot(candidatePath: string, bundledPkgRoot: string): boolean {
  try {
    const realCandidate = path.resolve(realpathSync(candidatePath));
    const realRoot = path.resolve(bundledPkgRoot);
    return realCandidate === realRoot || realCandidate.startsWith(realRoot + path.sep);
  } catch {
    // realpath failed (broken symlink? race?). Fall back to a textual
    // prefix check — this still catches the rare "PATH points directly
    // at the package dir" case.
    return path.resolve(candidatePath).startsWith(path.resolve(bundledPkgRoot) + path.sep);
  }
}

/**
 * Read tsx's package.json `bin` (string or object) and produce a
 * resolution that spawns the bin via `node <bin-js>`. This avoids
 * shebang/PATHEXT quirks across platforms.
 */
function buildResolutionFromPkgJson(pkgPath: string, source: TsxSource): TsxResolution {
  const pkgDir = path.dirname(pkgPath);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin?: string | Record<string, string> };

  let binRel: string | undefined;
  if (typeof pkg.bin === 'string') {
    binRel = pkg.bin;
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    binRel = pkg.bin.tsx;
  }
  if (!binRel) {
    throw new Error(`tsx package.json at ${pkgPath} has no bin.tsx entry`);
  }

  const binAbs = path.resolve(pkgDir, binRel);
  if (!existsSync(binAbs)) {
    throw new Error(`tsx bin ${binAbs} declared in package.json but missing on disk`);
  }

  // Spawn the bin .js via node directly. Portable across Windows/Unix —
  // no .cmd shim required, no PATHEXT lookups, no shebang dependency.
  return { command: process.execPath, args: [binAbs], source };
}

function resolveFromSource(
  source: 'bundled' | 'project' | 'path',
  projectRoot: string,
  forcedBy: 'env' | 'flag',
  pathOpts: PathLookupOpts,
): TsxResolution {
  let result: TsxResolution | null = null;
  if (source === 'project') result = tryProjectLocal(projectRoot);
  else if (source === 'path') result = tryPath(pathOpts);
  else result = resolveBundled();

  if (!result) {
    throw new Error(
      `tsx source=${source} requested via ${forcedBy} but resolution failed. ` +
        `Install tsx in your project or unset the override.`,
    );
  }
  return { ...result, forcedBy };
}

// ---------------------------------------------------------------------------
// Deprecation warning + state dir (A7)
// ---------------------------------------------------------------------------

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

/**
 * Compute the state dir for warning dedup (A7).
 *   1. CLAUDE_AUTOPILOT_STATE_DIR explicit override
 *   2. POSIX + XDG_STATE_HOME set → $XDG_STATE_HOME/claude-autopilot
 *   3. fallback → ~/.claude-autopilot
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.CLAUDE_AUTOPILOT_STATE_DIR) return env.CLAUDE_AUTOPILOT_STATE_DIR;
  if (platform !== 'win32' && env.XDG_STATE_HOME) {
    return path.join(env.XDG_STATE_HOME, 'claude-autopilot');
  }
  return path.join(os.homedir(), '.claude-autopilot');
}

function emitTsxDeprecationWarningSafe(opts: PathLookupOpts): void {
  // Opt-out for CI / log-hygiene.
  if (opts.env.CLAUDE_AUTOPILOT_NO_TSX_DEPRECATION === '1') return;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const dedupPath = path.join(stateDir(opts.env, opts.platform), '.tsx-deprecation-shown');

  try {
    if (existsSync(dedupPath)) {
      const lastShown = readFileSync(dedupPath, 'utf8').trim();
      if (lastShown === today) return;
    }
  } catch {
    // unreadable — fall through and print (better than silently swallowing)
  }

  try {
    mkdirSync(path.dirname(dedupPath), { recursive: true });
    writeFileSync(dedupPath, today);
  } catch {
    // Non-fatal: readonly homedir / sandbox / etc. We still print the
    // warning below — the user might see it twice in a row, but that's
    // preferable to silently swallowing in CI.
  }

  process.stderr.write(TSX_DEPRECATION_MESSAGE);
}

// Exported for testing.
export const __TSX_DEPRECATION_MESSAGE = TSX_DEPRECATION_MESSAGE;
