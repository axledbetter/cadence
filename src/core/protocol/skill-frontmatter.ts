/**
 * SKILL.md frontmatter loader — helper for callers that parse skill
 * frontmatter and want the protocol-loader handshake without wiring
 * the generic factory every time.
 *
 * v1.0.0 baseline: framework only. Not yet called from every skill
 * read site — that's a follow-up PR. See the protocol changelog
 * entry for 1.0.0.
 */

import { createProtocolLoader, type ProtocolLoader } from './loader.ts';
import { ensureMigrationsRegistered } from './migrations/index.ts';

export interface SkillFrontmatter {
  protocol_version?: string;
  name: string;
  description: string;
  // Skills are intentionally open — extra fields are preserved.
  [k: string]: unknown;
}

let _loader: ProtocolLoader<SkillFrontmatter> | null = null;

function getLoader(): ProtocolLoader<SkillFrontmatter> {
  if (_loader !== null) return _loader;
  ensureMigrationsRegistered();
  _loader = createProtocolLoader<SkillFrontmatter>({ component: 'skillFrontmatter' });
  return _loader;
}

/**
 * Validate and normalize SKILL.md frontmatter through the protocol
 * loader. Throws `ProtocolError` on validation / migration failure.
 */
export function loadSkillFrontmatter(raw: unknown): SkillFrontmatter {
  return getLoader().load(raw).value;
}

/** Test-only — reset the cached loader (used when swapping registries). */
export function _resetSkillFrontmatterLoader(): void {
  _loader = null;
}
