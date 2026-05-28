/**
 * Phase-output migrations.
 *
 * v1.0.0 baseline: empty. The 1.0.0 schema is the generic envelope
 * (`phase-output-1.0.0.json`); a future protocol bump may split into
 * phase-specific variants (e.g. `phase-output-implement-2.0.0.json`)
 * via the `COMPONENT_META.schemaName` indirection.
 */

import type { Migration } from '../../compat.ts';

export const MIGRATIONS: ReadonlyArray<Migration> = [];
