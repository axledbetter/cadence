/**
 * cadence profile upgrade [path] [--write] — rewrite a profile.yaml
 * to the canonical current-protocol shape.
 *
 * Default is DRY-RUN: prints a unified diff. With --write the file is
 * rewritten in place.
 *
 * Comment preservation: v1.0.0 baseline uses `yaml.dump()`, which
 * strips comments. A clear warning is printed when --write is used
 * with a file that contained comments. Full comment-preserving
 * rewrite is a follow-up (would require a CST-preserving YAML parser
 * such as eemeli/yaml).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { findPackageRoot } from './_pkg-root.ts';
import {
  createProtocolLoader,
  FilesystemSchemaRegistry,
} from '../core/protocol/loader.ts';
import { ensureMigrationsRegistered } from '../core/protocol/migrations/index.ts';
import { ProtocolError } from '../core/protocol/errors.ts';
import { PROTOCOL_VERSION } from '../core/protocol/version.ts';

export interface ProfileUpgradeOptions {
  /** Path to the profile.yaml file. Required. */
  filePath: string;
  /** When true, rewrite the file in place. Default false (dry-run). */
  write?: boolean;
  /** Override the package root (tests). */
  packageRoot?: string;
}

export interface ProfileUpgradeResult {
  exitCode: number;
  /** Bytes the file would be rewritten to. */
  canonicalYaml: string;
  /** Whether the on-disk file differs from the canonical form. */
  changed: boolean;
  /** Whether the original file had comments that would be lost on --write. */
  hadComments: boolean;
  /** Declared protocol version of the input. */
  declaredVersion: string;
  /** Current protocol version this loader speaks. */
  currentVersion: string;
}

/** Lossy comment detection — yaml.dump drops # comments. */
function detectComments(raw: string): boolean {
  // Strip strings to avoid false positives on `#` inside quoted values.
  // Cheap heuristic: any line whose first non-whitespace char is `#` or
  // any `#` preceded by a space/tab.
  const lines = raw.split('\n');
  for (const l of lines) {
    const trimmed = l.trim();
    if (trimmed.startsWith('#')) return true;
    if (/\s#/.test(l)) {
      // Could be inside a string; cheap heuristic accepts this as a
      // comment unless the # is inside matched quotes.
      const beforeHash = l.slice(0, l.indexOf(' #'));
      const dq = (beforeHash.match(/"/g) ?? []).length;
      const sq = (beforeHash.match(/'/g) ?? []).length;
      if (dq % 2 === 0 && sq % 2 === 0) return true;
    }
  }
  return false;
}

/**
 * Cheap unified-diff renderer — same format as `git diff --no-color`
 * minus the index/header. Good enough for CLI output; tests check the
 * content not the format.
 */
function unifiedDiff(before: string, after: string, label: string): string {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  const out: string[] = [`--- ${label} (current)`, `+++ ${label} (canonical)`];
  // Simplest possible diff: print every line, prefix unchanged with " ",
  // deletions with "-", additions with "+". Not LCS-optimal but readable.
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i += 1) {
    const av = i < a.length ? a[i] : undefined;
    const bv = i < b.length ? b[i] : undefined;
    if (av === bv) {
      out.push(` ${av ?? ''}`);
    } else {
      if (av !== undefined) out.push(`-${av}`);
      if (bv !== undefined) out.push(`+${bv}`);
    }
  }
  return out.join('\n');
}

export function runProfileUpgrade(opts: ProfileUpgradeOptions): ProfileUpgradeResult {
  const filePath = path.resolve(opts.filePath);
  if (!fs.existsSync(filePath)) {
    process.stderr.write(
      `\x1b[31m[cadence] profile upgrade: file not found: ${filePath}\x1b[0m\n`,
    );
    return {
      exitCode: 1,
      canonicalYaml: '',
      changed: false,
      hadComments: false,
      declaredVersion: '',
      currentVersion: PROTOCOL_VERSION,
    };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    process.stderr.write(
      `\x1b[31m[cadence] profile upgrade: invalid YAML: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`,
    );
    return {
      exitCode: 1,
      canonicalYaml: '',
      changed: false,
      hadComments: false,
      declaredVersion: '',
      currentVersion: PROTOCOL_VERSION,
    };
  }

  const packageRoot = opts.packageRoot ?? findPackageRoot(import.meta.url);
  if (!packageRoot) {
    process.stderr.write(
      `\x1b[31m[cadence] profile upgrade: cannot locate cadence package root\x1b[0m\n`,
    );
    return {
      exitCode: 1,
      canonicalYaml: '',
      changed: false,
      hadComments: false,
      declaredVersion: '',
      currentVersion: PROTOCOL_VERSION,
    };
  }
  ensureMigrationsRegistered();
  const loader = createProtocolLoader({
    component: 'profile',
    schemaRegistry: new FilesystemSchemaRegistry(packageRoot),
  });

  let result;
  try {
    result = loader.load(parsed);
  } catch (err) {
    if (err instanceof ProtocolError) {
      process.stderr.write(
        `\x1b[31m[cadence] profile upgrade: protocol handshake failed (${err.code}): ${err.message}\x1b[0m\n`,
      );
      if (err.hint) {
        process.stderr.write(`\x1b[2m  hint: ${err.hint}\x1b[0m\n`);
      }
      return {
        exitCode: 1,
        canonicalYaml: '',
        changed: false,
        hadComments: false,
        declaredVersion: '',
        currentVersion: PROTOCOL_VERSION,
      };
    }
    throw err;
  }

  const canonicalObj = result.value as Record<string, unknown>;
  // Ensure the canonical YAML carries `protocol_version` (the loader's
  // useDefaults filled it during validation, but if the loader treats
  // older-supported as additive, we want to assert the current version
  // explicitly on --write).
  if (typeof canonicalObj.protocol_version !== 'string' || canonicalObj.protocol_version !== result.currentVersion) {
    canonicalObj.protocol_version = result.currentVersion;
  }
  const canonicalYaml = yaml.dump(canonicalObj, { noRefs: true, lineWidth: 100, sortKeys: false });
  const changed = canonicalYaml !== raw;
  const hadComments = detectComments(raw);

  if (!opts.write) {
    if (!changed) {
      process.stdout.write(
        `[cadence] profile upgrade: ${filePath} already canonical (protocol ${result.currentVersion}); no changes.\n`,
      );
      return {
        exitCode: 0,
        canonicalYaml,
        changed,
        hadComments,
        declaredVersion: result.declaredVersion,
        currentVersion: result.currentVersion,
      };
    }
    process.stdout.write(
      `[cadence] profile upgrade: dry-run diff (declared ${result.declaredVersion} -> ${result.currentVersion}):\n\n`,
    );
    process.stdout.write(unifiedDiff(raw, canonicalYaml, path.basename(filePath)));
    process.stdout.write(`\n\nRe-run with --write to apply.\n`);
    if (hadComments) {
      process.stdout.write(
        `\x1b[33mwarning: source file contains YAML comments — --write will strip them in v1.0.0 (full comment preservation is a follow-up).\x1b[0m\n`,
      );
    }
    if (result.warnings.length > 0) {
      process.stdout.write(`migration warnings:\n`);
      for (const w of result.warnings) process.stdout.write(`  - ${w}\n`);
    }
    return {
      exitCode: 0,
      canonicalYaml,
      changed,
      hadComments,
      declaredVersion: result.declaredVersion,
      currentVersion: result.currentVersion,
    };
  }

  // --write
  if (!changed) {
    process.stdout.write(
      `[cadence] profile upgrade: ${filePath} already canonical; nothing to write.\n`,
    );
    return {
      exitCode: 0,
      canonicalYaml,
      changed,
      hadComments,
      declaredVersion: result.declaredVersion,
      currentVersion: result.currentVersion,
    };
  }
  if (hadComments) {
    process.stderr.write(
      `\x1b[33m[cadence] profile upgrade: source file contains YAML comments; --write will strip them.\x1b[0m\n`,
    );
  }
  fs.writeFileSync(filePath, canonicalYaml, 'utf8');
  process.stdout.write(
    `[cadence] profile upgrade: wrote canonical ${result.currentVersion} shape to ${filePath}\n`,
  );
  if (result.warnings.length > 0) {
    process.stdout.write(`migration warnings:\n`);
    for (const w of result.warnings) process.stdout.write(`  - ${w}\n`);
  }
  return {
    exitCode: 0,
    canonicalYaml,
    changed,
    hadComments,
    declaredVersion: result.declaredVersion,
    currentVersion: result.currentVersion,
  };
}

/** Dispatcher for `cadence profile upgrade <path> [--write]`. Wired
 *  from `cli/profile.ts` via the existing `profile` subcommand. */
export async function runProfileUpgradeCommand(args: string[]): Promise<number> {
  let filePath: string | undefined;
  let write = false;
  for (const a of args) {
    if (a === '--write') write = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(`
Usage: cadence profile upgrade <path/to/profile.yaml> [--write]

Default (dry-run): print the diff between the on-disk file and the
canonical current-protocol shape.

  --write   Rewrite the file in place. NOTE: v1.0.0 strips YAML
            comments on rewrite (comment preservation is a follow-up).

The cadence protocol version this binary speaks is printed at the top
of \`cadence --protocol\`.
`);
      return 0;
    }
    else if (a.startsWith('--')) {
      process.stderr.write(`\x1b[31m[cadence] profile upgrade: unknown flag: ${a}\x1b[0m\n`);
      return 1;
    }
    else if (filePath === undefined) {
      filePath = a;
    }
  }
  if (!filePath) {
    process.stderr.write(
      `\x1b[31m[cadence] profile upgrade: missing path to profile.yaml\x1b[0m\n`,
    );
    process.stderr.write(`\x1b[2m  usage: cadence profile upgrade <path> [--write]\x1b[0m\n`);
    return 1;
  }
  const result = runProfileUpgrade({ filePath, write });
  return result.exitCode;
}
