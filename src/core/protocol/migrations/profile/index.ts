/**
 * Profile-schema migrations.
 *
 * v1.0.0 baseline: empty. When the first breaking-within-major change
 * to profile.yaml ships, add a new file `<from>-to-<to>.ts` exporting
 * a `Migration` and append it to `MIGRATIONS`.
 */

import type { Migration } from '../../compat.ts';

export const MIGRATIONS: ReadonlyArray<Migration> = [];
