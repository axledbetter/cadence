/**
 * Strict, minimal semver utilities for protocol versions.
 *
 * Why not import a full semver library?
 *  - The protocol surface uses only MAJOR.MINOR.PATCH triplets — no
 *    prerelease tags, no build metadata, no ranges, no caret/tilde.
 *    A 50-line stdlib-style module is easier to reason about than a
 *    1000-line dependency where 95% of features don't apply.
 *  - Avoids a runtime dep just for `compare` / `parse`.
 *
 * Spec contract (codex WARNING — full triplet everywhere internally):
 *  - `normalize('1')`     → '1.0.0'
 *  - `normalize('1.2')`   → '1.2.0'
 *  - `normalize('1.2.0')` → '1.2.0'
 *  - `normalize('1.2.3.4')` / non-numeric segments → throws
 *    `ProtocolError(invalid_version)`.
 */

import { ProtocolError } from './errors.ts';

const SEMVER_SEGMENT_RE = /^\d+$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parse(v: string): ParsedVersion {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ProtocolError(`Invalid protocol version: ${JSON.stringify(v)}`, {
      code: 'invalid_version',
      details: { value: v },
    });
  }
  const segments = v.split('.');
  if (segments.length < 1 || segments.length > 3) {
    throw new ProtocolError(
      `Invalid protocol version "${v}": expected MAJOR[.MINOR[.PATCH]]`,
      { code: 'invalid_version', details: { value: v } },
    );
  }
  for (const seg of segments) {
    if (!SEMVER_SEGMENT_RE.test(seg)) {
      throw new ProtocolError(
        `Invalid protocol version "${v}": non-numeric segment ${JSON.stringify(seg)}`,
        { code: 'invalid_version', details: { value: v } },
      );
    }
  }
  const major = Number.parseInt(segments[0]!, 10);
  const minor = segments[1] === undefined ? 0 : Number.parseInt(segments[1], 10);
  const patch = segments[2] === undefined ? 0 : Number.parseInt(segments[2], 10);
  return { major, minor, patch };
}

/** Always returns a fully-qualified MAJOR.MINOR.PATCH string. */
export function normalize(v: string): string {
  const { major, minor, patch } = parse(v);
  return `${major}.${minor}.${patch}`;
}

/** -1 if a<b, 0 if equal, 1 if a>b. */
export function compare(a: string, b: string): -1 | 0 | 1 {
  const A = parse(a);
  const B = parse(b);
  if (A.major !== B.major) return A.major < B.major ? -1 : 1;
  if (A.minor !== B.minor) return A.minor < B.minor ? -1 : 1;
  if (A.patch !== B.patch) return A.patch < B.patch ? -1 : 1;
  return 0;
}

export function sameMajor(a: string, b: string): boolean {
  return parse(a).major === parse(b).major;
}
