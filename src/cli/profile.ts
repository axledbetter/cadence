/**
 * `claude-autopilot profile` — `show` + `list` subcommands.
 *
 * `profile show` — STRICT resolver invocation. Prints active profile
 * name + source + the fully-materialized config as YAML. Hard-fails on
 * any `ProfileResolutionError`, exit 1.
 *
 * `profile list` — profile-resolution-optional. Enumerates direct
 * `*.yaml` stems under `presets/profiles/` (skipping the `templates/`
 * subdir) and prints one name per line in alphabetical order. Does NOT
 * invoke `resolveProfile()` — `profile list` must still work in a repo
 * that has a broken `.autopilot/profile` so users can discover the
 * valid names they should put there.
 *
 * Both verbs share `runProfileCommand()` as the dispatch entry to keep
 * a single export surface for `src/cli/index.ts` to wire up.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { findPackageRoot } from './_pkg-root.ts';
import {
  resolveProfile,
  ENV_VAR_NAME,
} from '../core/profile/resolver.ts';
import { ProfileResolutionError } from '../core/profile/types.ts';

export interface ProfileShowOptions {
  /** Working directory (the repo whose `.autopilot/profile` is honored). */
  cwd: string;
  /** Optional `--profile <name>` value forwarded from the dispatcher. */
  flagProfile?: string;
  /** Optional env value forwarded from the dispatcher (defaults to `process.env`). */
  envProfile?: string;
}

export interface ProfileListOptions {
  /** Package root override (tests); defaults to `findPackageRoot()`. */
  packageRoot?: string;
}

/**
 * `profile show` — resolve the active profile strictly, print
 * `Profile: <name>` + `Source: <layer>` + YAML config to stdout. Any
 * `ProfileResolutionError` is surfaced as a one-line stderr message
 * with the typed code + hint, exit 1.
 */
export async function runProfileShow(opts: ProfileShowOptions): Promise<number> {
  let resolved;
  try {
    resolved = resolveProfile({
      cwd: opts.cwd,
      ...(opts.envProfile !== undefined ? { envProfile: opts.envProfile } : {}),
      ...(opts.flagProfile !== undefined ? { flagProfile: opts.flagProfile } : {}),
    });
  } catch (err) {
    if (err instanceof ProfileResolutionError) {
      process.stderr.write(`\x1b[31m[cadence] profile show: ${err.message}\x1b[0m\n`);
      if (err.hint) {
        process.stderr.write(`\x1b[2m  hint: ${err.hint}\x1b[0m\n`);
      }
      return 1;
    }
    throw err;
  }

  // Header — profile name + which precedence layer won. Color matches
  // `doctor` output convention (bold name, dim source).
  process.stdout.write(`\x1b[1mProfile:\x1b[0m ${resolved.name}\n`);
  process.stdout.write(`\x1b[2mSource:  ${resolved.source}\x1b[0m\n`);
  process.stdout.write('\n');

  // Body — full resolved config as YAML so users see EVERY effective
  // value (including the in-code defaults the schema doesn't enforce).
  // Use `noRefs: true` so anchors/aliases don't leak into the dump.
  process.stdout.write(yaml.dump(resolved.config, { noRefs: true, lineWidth: 100 }));

  return 0;
}

/**
 * `profile list` — enumerate `presets/profiles/*.yaml` stems and print
 * one per line in alphabetical order. Profile-optional: does NOT call
 * `resolveProfile()` so a broken `.autopilot/profile` does not block
 * the user from discovering the valid names.
 *
 * Returns exit code: 0 on success, 1 if the package root can't be
 * located (reinstall hint).
 */
export function runProfileList(opts: ProfileListOptions = {}): number {
  const packageRoot = opts.packageRoot ?? findPackageRoot(import.meta.url);
  if (!packageRoot) {
    process.stderr.write(
      `\x1b[31m[cadence] profile list: could not locate the cadence package root.\x1b[0m\n`,
    );
    process.stderr.write(
      `\x1b[2m  hint: reinstall — npm install -g @delegance/cadence\x1b[0m\n`,
    );
    return 1;
  }
  const profilesDir = path.join(packageRoot, 'presets', 'profiles');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  } catch (err) {
    process.stderr.write(
      `\x1b[31m[cadence] profile list: failed to read ${profilesDir}: ` +
        `${err instanceof Error ? err.message : String(err)}\x1b[0m\n`,
    );
    return 1;
  }
  // Mirror the resolver's `enumerateAvailableStems()` contract: only
  // direct `*.yaml` files, skip the `templates/` subdir. We can't
  // import that helper (it's not exported), but the rules MUST match
  // or `profile list` could advertise a name that `profile show`
  // rejects (or vice versa). The shared regex + stem-enumeration
  // contract lives in the resolver — keep them parallel here.
  const stems: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.yaml')) continue;
    stems.push(entry.name.slice(0, -'.yaml'.length));
  }
  stems.sort();
  for (const stem of stems) {
    process.stdout.write(`${stem}\n`);
  }
  return 0;
}

/**
 * Dispatcher for `cadence profile <subcommand>`. Wired from
 * `src/cli/index.ts` under the `profile` case. Unknown / missing
 * sub-verb → usage text + exit 1.
 */
export async function runProfileCommand(
  args: string[],
  opts: { cwd: string; flagProfile?: string } = { cwd: process.cwd() },
): Promise<number> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(`
Usage: cadence profile <sub-verb>

Sub-verbs:
  show           Print the active profile + source + resolved YAML config
  list           Print available profile names (one per line, alphabetical)

Resolution precedence for \`show\` (lowest → highest):
  default(solo) → .autopilot/profile → ${ENV_VAR_NAME} env → --profile flag

Examples:
  cadence profile show
  cadence profile show --profile enterprise
  cadence profile list
`);
    return 0;
  }
  if (sub === 'show') {
    return runProfileShow({
      cwd: opts.cwd,
      ...(opts.flagProfile !== undefined ? { flagProfile: opts.flagProfile } : {}),
      envProfile: process.env[ENV_VAR_NAME],
    });
  }
  if (sub === 'list') {
    return runProfileList();
  }
  process.stderr.write(
    `\x1b[31m[cadence] profile: unknown sub-verb "${sub}" — valid: show, list\x1b[0m\n`,
  );
  return 1;
}
