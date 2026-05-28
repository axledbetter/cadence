/**
 * cadence --protocol flag handler + cadence protocol changelog
 * subcommand.
 *
 * Spec: docs/superpowers/specs/2026-05-27-protocol-versioning-design.md.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { findPackageRoot } from './_pkg-root.ts';
import {
  COMPONENT_META,
  COMPONENT_VERSIONS,
  PROTOCOL_VERSION,
  type ComponentKind,
} from '../core/protocol/version.ts';
import { compare } from '../core/protocol/semver.ts';
import { ProtocolError } from '../core/protocol/errors.ts';

/** cadence --protocol — print the protocol version + component map. */
export function runProtocolPrint(): number {
  process.stdout.write(`cadence-protocol ${PROTOCOL_VERSION}\n`);
  process.stdout.write('components:\n');
  const kinds = Object.keys(COMPONENT_VERSIONS) as ComponentKind[];
  // Stable alphabetical order — predictable output for tests + diffing.
  kinds.sort();
  for (const kind of kinds) {
    const meta = COMPONENT_META[kind];
    process.stdout.write(`  ${kind} (${meta.schemaName}): ${meta.currentVersion}\n`);
  }
  return 0;
}

/**
 * Resolve the changelog file location. Tries the package root first
 * (covers both source checkouts AND npm-installed copies — the npm
 * package ships src/ per existing convention, see package.json files field).
 */
function resolveChangelogPath(): string | null {
  const root = findPackageRoot(import.meta.url);
  if (!root) return null;
  const p = path.join(root, 'src', 'core', 'protocol', 'changelog.md');
  if (!fs.existsSync(p)) return null;
  return p;
}

export interface ProtocolChangelogOptions {
  /** Print only versions greater than or equal to this (semver triplet). */
  since?: string;
}

/** cadence protocol changelog [--since=X.Y.Z] — print the protocol
 *  changelog, optionally filtered. */
export function runProtocolChangelog(opts: ProtocolChangelogOptions = {}): number {
  const p = resolveChangelogPath();
  if (!p) {
    process.stderr.write(
      `\x1b[31m[cadence] protocol changelog: could not locate src/core/protocol/changelog.md\x1b[0m\n`,
    );
    process.stderr.write(
      `\x1b[2m  hint: reinstall — npm install -g @delegance/cadence\x1b[0m\n`,
    );
    return 1;
  }
  const raw = fs.readFileSync(p, 'utf8');
  if (!opts.since) {
    process.stdout.write(raw);
    return 0;
  }
  // Filter: walk the file, keep header + sections whose `## X.Y.Z` heading
  // is greater than or equal to since.
  const sinceTriplet = opts.since;
  const lines = raw.split('\n');
  const out: string[] = [];
  let keepingHeader = true;
  let keepingSection = true;
  const headingRe = /^##\s+(\d+\.\d+\.\d+)\b/;
  for (const line of lines) {
    const m = headingRe.exec(line);
    if (m) {
      keepingHeader = false;
      const version = m[1]!;
      try {
        keepingSection = compare(version, sinceTriplet) >= 0;
      } catch (err) {
        if (err instanceof ProtocolError) {
          process.stderr.write(
            `\x1b[31m[cadence] protocol changelog: invalid --since value "${sinceTriplet}"\x1b[0m\n`,
          );
          return 1;
        }
        throw err;
      }
    }
    if (keepingHeader || keepingSection) {
      out.push(line);
    }
  }
  process.stdout.write(out.join('\n'));
  return 0;
}

/** Dispatcher for cadence protocol <sub>. */
export async function runProtocolCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(`
Usage: cadence protocol <sub-verb>

Sub-verbs:
  changelog [--since=X.Y.Z]   Print the cadence protocol changelog
  --help                      This help text

Top-level:
  cadence --protocol          Print the protocol version + component map

The cadence protocol is versioned INDEPENDENTLY from the @delegance/cadence
npm package. See docs/superpowers/specs/2026-05-27-protocol-versioning-design.md
`);
    return 0;
  }
  if (sub === 'changelog') {
    let since: string | undefined;
    for (let i = 1; i < args.length; i += 1) {
      const a = args[i]!;
      if (a.startsWith('--since=')) {
        since = a.slice('--since='.length);
      } else if (a === '--since') {
        since = args[i + 1];
        i += 1;
      }
    }
    return runProtocolChangelog(since !== undefined ? { since } : {});
  }
  process.stderr.write(
    `\x1b[31m[cadence] protocol: unknown sub-verb "${sub}" — valid: changelog\x1b[0m\n`,
  );
  return 1;
}
