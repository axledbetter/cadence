// src/core/migrate/handshake.ts
//
// Reads <skillPath>/skill.manifest.json and verifies compatibility:
// - runtimeVersion must satisfy [min_runtime, max_runtime] (semver, no pre-release)
// - skill_runtime_api_version major must equal envelopeContractVersion major
//
// Fails closed: missing/invalid manifest is rejected, not silently allowed.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillManifest } from './types.ts';

export interface HandshakeOptions {
  skillPath: string;
  runtimeVersion: string;          // e.g. "5.2.0" — read from package.json
  envelopeContractVersion: string; // ENVELOPE_CONTRACT_VERSION
}

export type HandshakeResult =
  | { ok: true; manifest: SkillManifest }
  | { ok: false; reasonCode: HandshakeReason; message: string };

export type HandshakeReason =
  | 'manifest-missing'
  | 'manifest-invalid'
  | 'runtime-below-min'
  | 'runtime-above-max'
  | 'api-version-mismatch';

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

function parseSemver(s: string): SemVer | null {
  // Match X.Y.Z or X.Y.Z-prerelease
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(s);
  if (!m) return null;
  return {
    major: parseInt(m[1]!, 10),
    minor: parseInt(m[2]!, 10),
    patch: parseInt(m[3]!, 10),
    ...(m[4] ? { prerelease: m[4] } : {}),
  };
}

/**
 * Parse a range expressed as either:
 * - "X.Y.Z" -> exact lower bound (>= X.Y.Z)
 * - "X.x" or "X.*" -> upper bound (< (X+1).0.0)
 */
function parseRangeBound(s: string): { major: number; minor: number; patch: number; isWildcard: boolean } | null {
  const wildcard = /^(\d+)\.[xX*]$/.exec(s) ?? /^(\d+)\.[xX*]\.[xX*]$/.exec(s);
  if (wildcard) {
    return { major: parseInt(wildcard[1]!, 10), minor: 0, patch: 0, isWildcard: true };
  }
  const exactBound = parseSemver(s);
  if (exactBound) {
    return { major: exactBound.major, minor: exactBound.minor, patch: exactBound.patch, isWildcard: false };
  }
  return null;
}

function compare(a: SemVer, b: { major: number; minor: number; patch: number }): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  return 0;
}

function isWithinRange(version: string, min: string, max: string): { ok: true } | { ok: false; reason: 'runtime-below-min' | 'runtime-above-max' } {
  const v = parseSemver(version);
  if (!v) return { ok: false, reason: 'runtime-below-min' };
  // Strict semver: pre-release versions don't satisfy plain ranges
  if (v.prerelease) return { ok: false, reason: 'runtime-below-min' };

  const lo = parseRangeBound(min);
  const hi = parseRangeBound(max);
  if (!lo || !hi) return { ok: false, reason: 'runtime-below-min' };

  if (compare(v, lo) < 0) return { ok: false, reason: 'runtime-below-min' };
  if (hi.isWildcard) {
    // major.x means < (major+1).0.0
    if (v.major > hi.major) return { ok: false, reason: 'runtime-above-max' };
  } else {
    if (compare(v, hi) > 0) return { ok: false, reason: 'runtime-above-max' };
  }
  return { ok: true };
}

function isValidManifest(o: unknown): o is SkillManifest {
  if (!o || typeof o !== 'object') return false;
  const m = o as Record<string, unknown>;
  return (
    typeof m.skillId === 'string' &&
    typeof m.skill_runtime_api_version === 'string' &&
    typeof m.min_runtime === 'string' &&
    typeof m.max_runtime === 'string'
  );
}

export function performHandshake(opts: HandshakeOptions): HandshakeResult {
  const manifestPath = path.join(opts.skillPath, 'skill.manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return {
      ok: false,
      reasonCode: 'manifest-missing',
      message: `skill.manifest.json not found at ${manifestPath}`,
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    return { ok: false, reasonCode: 'manifest-invalid', message: `cannot read manifest: ${(err as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reasonCode: 'manifest-invalid', message: `manifest JSON parse failed: ${(err as Error).message}` };
  }

  if (!isValidManifest(parsed)) {
    return { ok: false, reasonCode: 'manifest-invalid', message: 'manifest missing required fields (skillId, skill_runtime_api_version, min_runtime, max_runtime)' };
  }

  // API major check
  const apiMajor = (s: string) => s.split('.')[0];
  if (apiMajor(parsed.skill_runtime_api_version) !== apiMajor(opts.envelopeContractVersion)) {
    return {
      ok: false,
      reasonCode: 'api-version-mismatch',
      message: `skill API version ${parsed.skill_runtime_api_version} incompatible with envelope contract ${opts.envelopeContractVersion} (major must match)`,
    };
  }

  // Runtime range check
  const range = isWithinRange(opts.runtimeVersion, parsed.min_runtime, parsed.max_runtime);
  if (!range.ok) {
    const reason = range.reason;
    const hint = reason === 'runtime-below-min'
      ? `requires runtime >= ${parsed.min_runtime}, got ${opts.runtimeVersion} -- run \`npm install -g @delegance/cadence@latest\``
      : `requires runtime <= ${parsed.max_runtime}, got ${opts.runtimeVersion} -- pin an older runtime or upgrade the skill`;
    return {
      ok: false,
      reasonCode: reason,
      message: `skill ${parsed.skillId} ${hint}`,
    };
  }

  return { ok: true, manifest: parsed };
}
