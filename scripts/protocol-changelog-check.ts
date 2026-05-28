#!/usr/bin/env node
/**
 * CI gate — fails if a PR modifies a protocol-versioned schema or
 * migration file WITHOUT a matching entry in
 * `src/core/protocol/changelog.md`.
 *
 * Tracked paths:
 *   - presets/schemas/*.json
 *   - src/core/protocol/version.ts
 *   - src/core/protocol/migrations/(profile|skill-frontmatter|state|phase-output)/<edge>.ts
 *     (excludes the per-component `index.ts` and `.gitkeep` boilerplate)
 *
 * Comparison base: `git merge-base origin/master HEAD` if available,
 * else `git rev-parse master`, else hard-fail.
 *
 * Spec: docs/superpowers/specs/2026-05-27-protocol-versioning-design.md.
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

interface CheckResult {
  exitCode: number;
  trackedChanged: string[];
  changelogChanged: boolean;
  message: string;
}

const TRACKED_GLOBS: ReadonlyArray<RegExp> = [
  /^presets\/schemas\/.+\.json$/,
  /^src\/core\/protocol\/version\.ts$/,
  /^src\/core\/protocol\/migrations\/(?:profile|skill-frontmatter|state|phase-output)\/(?!index\.ts$|\.gitkeep$).+\.ts$/,
];

const CHANGELOG_PATH = 'src/core/protocol/changelog.md';

function isTracked(file: string): boolean {
  // Normalize Windows path separators just in case.
  const f = file.replace(/\\/g, '/');
  return TRACKED_GLOBS.some(re => re.test(f));
}

function gitCapture(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    throw new Error(`git ${args.join(' ')} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function resolveBase(): string {
  // Prefer origin/master merge-base (CI default).
  try {
    return gitCapture(['merge-base', 'origin/master', 'HEAD']).trim();
  } catch {
    // Fall back to local master rev (worktrees / no remote).
    try {
      return gitCapture(['rev-parse', 'master']).trim();
    } catch {
      throw new Error(
        'Cannot resolve a comparison base — neither `origin/master` nor `master` exists.',
      );
    }
  }
}

export function runCheck(cwd: string = process.cwd()): CheckResult {
  const originalCwd = process.cwd();
  try {
    process.chdir(cwd);
    const base = resolveBase();
    const diffOutput = gitCapture(['diff', '--name-only', `${base}..HEAD`]);
    const stagedOutput = gitCapture(['diff', '--name-only', '--cached']);
    const unstagedOutput = gitCapture(['diff', '--name-only']);
    // Also count untracked files — a brand-new schema or migration file
    // would otherwise slip past this gate on the local pre-commit run.
    const untrackedOutput = gitCapture(['ls-files', '--others', '--exclude-standard']);
    const seen = new Set<string>();
    for (const blob of [diffOutput, stagedOutput, unstagedOutput, untrackedOutput]) {
      for (const f of blob.split('\n')) {
        const t = f.trim();
        if (t.length > 0) seen.add(t);
      }
    }
    const trackedChanged: string[] = [];
    let changelogChanged = false;
    for (const f of seen) {
      if (f === CHANGELOG_PATH) {
        changelogChanged = true;
        continue;
      }
      if (isTracked(f)) trackedChanged.push(f);
    }
    if (trackedChanged.length === 0) {
      return {
        exitCode: 0,
        trackedChanged,
        changelogChanged,
        message: 'No tracked schema or migration files modified; changelog gate skipped.',
      };
    }
    if (!changelogChanged) {
      return {
        exitCode: 1,
        trackedChanged,
        changelogChanged,
        message:
          `Protocol gate FAILED — these files were modified:\n  ${trackedChanged.join('\n  ')}\n\n` +
          `but ${CHANGELOG_PATH} was NOT updated in the same diff range. ` +
          `Every protocol-touching PR must add a corresponding changelog entry. ` +
          `See docs/superpowers/specs/2026-05-27-protocol-versioning-design.md.`,
      };
    }
    return {
      exitCode: 0,
      trackedChanged,
      changelogChanged,
      message:
        `Protocol gate OK — ${trackedChanged.length} tracked file(s) modified, ` +
        `changelog entry present.`,
    };
  } finally {
    process.chdir(originalCwd);
  }
}

// CLI entry — only runs when this script is invoked directly.
const isMain = (() => {
  try {
    return import.meta.url === `file://${path.resolve(process.argv[1] ?? '')}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  const result = runCheck();
  if (result.exitCode === 0) {
    process.stdout.write(`[protocol-changelog-check] ${result.message}\n`);
  } else {
    process.stderr.write(`\x1b[31m[protocol-changelog-check] ${result.message}\x1b[0m\n`);
  }
  process.exit(result.exitCode);
}
