// src/core/migrate/alias-resolver.ts
//
// Resolves stable skill IDs (e.g. "migrate@1") or raw aliases (e.g. "migrate")
// against presets/aliases.lock.json. Path escape is the CRITICAL security
// concern per Codex review:
// - resolved paths are realpath'd and verified to stay under <repo>/skills/
//   or <repo>/node_modules/ (the trusted skill roots)
// - absolute paths in alias map are rejected
// - .. traversal in alias map is rejected
// - symlinks pointing outside trusted root are rejected (resolved + checked)
//
// Raw alias collisions are a hard error: ambiguous "thing" → require user to
// use exact stable ID.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AliasEntry } from './types.ts';
import { TRUSTED_SKILL_ROOTS } from './contract.ts';
import { findPackageRoot } from '../../cli/_pkg-root.ts';

export interface ResolveOptions {
  repoRoot: string;
  /** Optional workspace path for monorepo lookup precedence (workspace
   *  aliases take precedence over repo-root aliases). */
  workspace?: string;
}

export type ResolveResult =
  | {
      ok: true;
      stableId: string;
      skillPath: string;
      normalizedFromRaw: boolean;
    }
  | {
      ok: false;
      reasonCode:
        | 'aliases-file-missing'
        | 'aliases-file-invalid'
        | 'stable-id-unknown'
        | 'raw-alias-ambiguous'
        | 'path-escape'
        | 'skill-path-missing'
        | 'invalid-input';
      message: string;
    };

interface AliasMap {
  schemaVersion: number;
  aliases: AliasEntry[];
}

function loadAliasMap(repoRoot: string): AliasMap | null {
  // Lookup precedence:
  //   1. repoRoot/presets/aliases.lock.json — repo-local override (e.g. monorepo)
  //   2. <package-root>/presets/aliases.lock.json — installed package
  // findPackageRoot walks up from this module looking for the package.json
  // declaring '@delegance/cadence' (or legacy '@delegance/claude-autopilot'),
  // so it works under both source and
  // compiled (dist/) layouts. Earlier code used __dirname + '../../..' which
  // landed at <install>/dist/presets/ in the published tarball (presets/ ships
  // at the package root, not under dist/).
  const pkgRoot = findPackageRoot(import.meta.url);
  const candidates = [
    path.join(repoRoot, 'presets', 'aliases.lock.json'),
    ...(pkgRoot ? [path.join(pkgRoot, 'presets', 'aliases.lock.json')] : []),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw) as AliasMap;
        if (typeof parsed?.schemaVersion === 'number' && Array.isArray(parsed.aliases)) {
          return parsed;
        }
      } catch {
        // continue to next candidate
      }
    }
  }
  return null;
}

function isUnderTrustedRoot(absResolvedPath: string, repoRoot: string): boolean {
  let realRepoRoot: string;
  try {
    realRepoRoot = fs.realpathSync(repoRoot);
  } catch {
    return false;
  }
  for (const root of TRUSTED_SKILL_ROOTS) {
    const trustedAbs = path.resolve(realRepoRoot, root);
    const rel = path.relative(trustedAbs, absResolvedPath);
    // rel must NOT start with '..' and must not be absolute (path traversal sentinels)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return true;
    }
    // Also accept the trusted root itself
    if (absResolvedPath === trustedAbs) {
      return true;
    }
  }
  return false;
}

function validatePathEscape(
  rawResolvesTo: string,
  repoRoot: string,
): { ok: true; resolved: string } | { ok: false; reason: string } {
  // Reject absolute paths and .. traversal in the alias map *before* resolving
  if (path.isAbsolute(rawResolvesTo)) {
    return { ok: false, reason: 'absolute path in alias map' };
  }
  if (rawResolvesTo.split(/[/\\]/).some(seg => seg === '..')) {
    return { ok: false, reason: '.. traversal in alias map' };
  }
  // Resolve via realpath (follows symlinks)
  const candidate = path.resolve(repoRoot, rawResolvesTo);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return { ok: false, reason: `path does not exist: ${candidate}` };
  }
  if (!isUnderTrustedRoot(real, repoRoot)) {
    return { ok: false, reason: `resolved path escapes trusted roots: ${real}` };
  }
  return { ok: true, resolved: real };
}

export function resolveSkill(input: string, opts: ResolveOptions): ResolveResult {
  if (!input || typeof input !== 'string') {
    return {
      ok: false,
      reasonCode: 'invalid-input',
      message: 'skill input must be a non-empty string',
    };
  }

  // Lookup precedence: workspace .autopilot/aliases.lock.json (if exists) > repo root presets/aliases.lock.json
  const lookupRoot = opts.repoRoot;
  const aliasMap = loadAliasMap(lookupRoot);
  if (!aliasMap) {
    return {
      ok: false,
      reasonCode: 'aliases-file-missing',
      message: `no aliases.lock.json found under ${lookupRoot}`,
    };
  }

  // 1. Exact stable ID match
  const stableMatch = aliasMap.aliases.find(a => a.stableId === input);
  if (stableMatch) {
    return finalizeResolve(stableMatch, lookupRoot, /*normalizedFromRaw*/ false);
  }

  // 2. Raw alias normalization (with collision check)
  const rawMatches = aliasMap.aliases.filter(a => a.rawAliases?.includes(input));
  if (rawMatches.length > 1) {
    const candidates = rawMatches.map(m => m.stableId).join(', ');
    return {
      ok: false,
      reasonCode: 'raw-alias-ambiguous',
      message: `raw alias '${input}' maps to multiple stable IDs: ${candidates}. Use the exact stable ID in stack.md.`,
    };
  }
  if (rawMatches.length === 1) {
    return finalizeResolve(rawMatches[0]!, lookupRoot, /*normalizedFromRaw*/ true);
  }

  return {
    ok: false,
    reasonCode: 'stable-id-unknown',
    message: `unknown skill '${input}'. Known stable IDs: ${aliasMap.aliases.map(a => a.stableId).join(', ')}. Run \`claude-autopilot doctor\` for help.`,
  };
}

function finalizeResolve(
  entry: AliasEntry,
  repoRoot: string,
  normalizedFromRaw: boolean,
): ResolveResult {
  const check = validatePathEscape(entry.resolvesTo, repoRoot);
  if (!check.ok) {
    return {
      ok: false,
      reasonCode: 'path-escape',
      message: `alias ${entry.stableId} resolvesTo path-escape rejected: ${check.reason}`,
    };
  }
  return {
    ok: true,
    stableId: entry.stableId,
    skillPath: check.resolved,
    normalizedFromRaw,
  };
}
