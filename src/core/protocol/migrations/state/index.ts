/**
 * state.json migrations.
 *
 * v1.0.0 baseline: empty. Note: the v6 RunState `schema_version` field
 * is a separate concern (internal engine wire format); protocol-level
 * migrations affect the OUTER protocol_version envelope, not the
 * engine's internal schema_version.
 */

import type { Migration } from '../../compat.ts';

export const MIGRATIONS: ReadonlyArray<Migration> = [];
