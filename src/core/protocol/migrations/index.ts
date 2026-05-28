/**
 * Migration registry assembly.
 *
 * v1.0.0 baseline (this PR): zero migrations. Each per-component
 * directory exports an empty `MIGRATIONS` array. When the first
 * breaking-within-major change ships for a component, add a file
 * `migrations/<component>/<from>-to-<to>.ts` that exports a
 * `Migration` object, then re-export it from that component's
 * `index.ts`. The CI changelog gate (`scripts/protocol-changelog-check.ts`)
 * blocks the merge if `src/core/protocol/changelog.md` isn't updated
 * in the same commit.
 *
 * NOTE: This module is side-effect-free aside from registering edges
 * on `DEFAULT_REGISTRY`. Tests that need a clean registry should
 * construct their own `MigrationRegistry` instance and pass it through
 * loader / satisfies / migrate option overrides.
 */

import { DEFAULT_REGISTRY, type Migration } from '../compat.ts';
import { MIGRATIONS as PROFILE_MIGRATIONS } from './profile/index.ts';
import { MIGRATIONS as SKILL_FRONTMATTER_MIGRATIONS } from './skill-frontmatter/index.ts';
import { MIGRATIONS as STATE_MIGRATIONS } from './state/index.ts';
import { MIGRATIONS as PHASE_OUTPUT_MIGRATIONS } from './phase-output/index.ts';

export const ALL_MIGRATIONS: ReadonlyArray<Migration> = Object.freeze([
  ...PROFILE_MIGRATIONS,
  ...SKILL_FRONTMATTER_MIGRATIONS,
  ...STATE_MIGRATIONS,
  ...PHASE_OUTPUT_MIGRATIONS,
]);

let _registered = false;

/** Register every shipped migration on `DEFAULT_REGISTRY`. Idempotent —
 *  safe to call from multiple entry points. */
export function ensureMigrationsRegistered(): void {
  if (_registered) return;
  for (const m of ALL_MIGRATIONS) {
    DEFAULT_REGISTRY.register(m);
  }
  _registered = true;
}
