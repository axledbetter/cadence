---
title: Schema-Change Manifests — Implementation Plan
date: 2026-05-27
spec: docs/superpowers/specs/2026-05-27-schema-change-manifests-design.md
risk_tier: high
status: plan
---

# Implementation Plan

## Scope reminder

Adds a first-class, typed `schemaChanges[]` array to the implement-phase
output. The phase fails fast unless every detector-detected semantic change
in a touched schema file is matched by a manifest entry. Validate-phase
enforces policy (NOT NULL backfill, deprecation, expand-contract). The PR
creation phase renders the manifest into the PR body via a marker.

Profile defaults to **empty `schemaPaths`** → no behavior change for users
who haven't opted in.

## File-by-file change list

### NEW — `src/core/schema-changes/types.ts`

The full taxonomy and types from spec §2:

- `SchemaChangeKind` — Postgres-aware: DDL + RLS / grants / functions /
  views / triggers + data + GraphQL + OpenAPI + protobuf + TypeScript +
  `unknown.unparseable` / `unknown.unsupported_kind`.
- `PolicyEvidence { backfillSql?, deprecation?, compatibilityNotes? }`.
- `ExpandContractEvidence { phase, pairedWith?, requiresMergedBefore?,
  requiresBackfillComplete?, compatibleWithPreviousAppVersion,
  affectedRuntimes? }`.
- `SchemaChangeEntry { file, kind, objectName?, operation?, additive,
  description, rollback?, consumers?, policyEvidence?, expandContract? }`.

### NEW — `src/core/schema-changes/detectors/sql.ts`

Uses **`libpg_query`** (Postgres-native parser).

- Diffs parsed statement lists between `beforeText` and `afterText`.
- Recognizes: CREATE/DROP/RENAME TABLE, ADD/DROP/ALTER COLUMN,
  CREATE/DROP INDEX, CREATE/DROP/ALTER VIEW, FUNCTION, TRIGGER, EXTENSION;
  ENABLE/DISABLE RLS, FORCE RLS, CREATE/ALTER/DROP POLICY, GRANT, REVOKE,
  CREATE/ALTER/DROP ROLE; data ops (UPDATE/DELETE/TRUNCATE).
- `additive` heuristics: CREATE * is additive (except DROP / RENAME).
  `ADD COLUMN` without NOT NULL is additive; with NOT NULL or default change
  isn't. DROP / TRUNCATE / REVOKE / drop_policy / disable_rls are destructive.
- Falls back to a single `unknown.unparseable` entry per file if libpg_query
  throws (preserves the parse error in `description`).
- Granularity: **one entry per semantic statement**, not per file (matches
  codex CRITICAL).

### NEW — `src/core/schema-changes/detectors/graphql.ts`

Uses `graphql` package (peer-installed). `parse` both texts, walk the type
definitions, diff fields and enum values. Maps to `graphql.add_field`,
`graphql.remove_field`, `graphql.add_enum_value`,
`graphql.remove_enum_value`, `graphql.deprecate_field`. Missing
package → `unknown.unsupported_kind`.

### NEW — `src/core/schema-changes/detectors/openapi.ts`

JSON / YAML parse (yaml already in tree via js-yaml). Walks `paths.*` keys
to detect `add_endpoint` / `remove_endpoint`, compares `responses` /
`requestBody` for `change_response` / `change_request`. Path-shape-only;
not a full semantic differ.

### NEW — `src/core/schema-changes/detectors/typescript.ts`

Uses the TypeScript Compiler API (already a devDependency). For each file
it parses both texts as `ts.SourceFile`, lists exported symbols by name,
hashes each export's printed text. New name → `typescript.add_export`;
removed → `typescript.remove_export`; changed hash → `typescript.change_signature`.

### NEW — `src/core/schema-changes/detectors/protobuf.ts`

Uses `protobufjs` if present (peer); detects `protobuf.add_field`,
`protobuf.deprecate_field`, `protobuf.reserve_field`. If absent →
`unknown.unsupported_kind`.

### NEW — `src/core/schema-changes/detectors/index.ts`

`detectChangesForFile({ file, beforeText, afterText })` → dispatches by
extension / glob:

- `.sql` → sql.ts
- `.graphql` / `.gql` → graphql.ts
- `openapi.{yaml,yml,json}` or path containing `openapi` → openapi.ts
- `.proto` → protobuf.ts
- `.ts` / `.tsx` → typescript.ts
- otherwise → `unknown.unsupported_kind` single-entry.

Aggregator `detectAllChanges({ files: [{path, before, after}] })`
returns `SchemaChangeEntry[]`.

### NEW — `src/core/schema-changes/validator.ts`

Pure functions, no IO:

- `crossCheckManifest({ manifest, detected })` — for every detected
  semantic change there must be a manifest entry on
  `{file, kind, objectName, operation}`. Mismatch → list of issues.
- `reverseCheck({ manifest, detected })` — every manifest entry must
  match a detected change (or carry `additiveOverride` reason).
- `enforcePolicy({ manifest, policy })` — `blockNotNullWithoutBackfill`,
  `blockDropColumnWithoutDeprecation`, `blockRlsWeakeningWithoutSecurityReview`,
  `destructiveRequiresExpandContract`, `pairedWithMustExist` (latter takes
  optional probe; pure logic when probe is absent).
- Returns `{ ok, issues: Array<{ severity, code, message, entry? }> }`.

### NEW — `src/core/schema-changes/pr-template.ts`

`renderManifestMarkdown(entries)` — markdown table per spec §6.
`injectIntoPrBody(body, entries)` — replaces the
`<!-- cadence:schema-changes -->` marker, idempotent (works if marker
already replaced by an earlier render — strip the prior block).

### NEW — `src/cli/schema-scan.ts`

`cadence schema scan` — reads the current diff (worktree vs `HEAD`),
runs detectors, emits a skeleton manifest as JSON / YAML for the agent
to hand-edit. Pure-CLI verb; no run-state coupling.

### EDIT — `src/core/autopilot/run-state-schema.ts`

- Import `SchemaChangeEntry` from `../schema-changes/types.ts`.
- Add optional `schemaChanges?: SchemaChangeEntry[]` to
  `ImplementPhaseOutput`.
- Extend `validateImplement()`:
  - if `schemaChanges` present, validate each entry has required fields
    for its kind (string `file`, string `description`, valid kind, boolean
    `additive`).
  - returns `schemaChanges` in the validated output unchanged.

### EDIT — `src/core/profile/types.ts`

Add to `ProfileConfig`:
```typescript
schemaPaths?: string[];                   // default []
schemaConsumers?: string[];               // default []
schemaChangePolicy?: {
  destructiveRequiresExpandContract?: boolean;  // default true
  blockNotNullWithoutBackfill?: boolean;        // default true
  blockDropColumnWithoutDeprecation?: boolean;  // default true
  blockRlsWeakeningWithoutSecurityReview?: boolean; // default true
};
```

### EDIT — `presets/schemas/profile.schema.json`

Mirror the new fields. `schemaPaths` items are strings (globs). Defaults
are all empty / off (so existing profiles see no change).

### EDIT — `src/core/autopilot/run-lifecycle.ts`

`endPhase('implement', output)`: when `output.schemaChanges` is non-empty
or when any file in the diff matches `profile.schemaPaths`, run a
cross-check + reverse-check helper. **The cross-check itself stays in
`validator.ts` to keep the lifecycle file pure of detector dependencies.**
Lifecycle owns the orchestration only. Throws `GuardrailError('invalid_config')`
with code `incomplete_phase_output` (added below).

To avoid loading the SQL parser in tests that don't exercise it, the
detector dispatch is lazy-imported only when the profile opts in.

### EDIT — `src/core/errors.ts`

Add `'incomplete_phase_output'` to `ErrorCode`. Default `retryable: false`.

### EDIT — `src/cli/index.ts` (or wherever verbs register)

Register the new `schema` verb (sub-verb `scan`) per existing CLI plumbing.

### EDIT — `bin/cadence.js`

Likely no change — dispatches to `src/cli/index.ts`.

### NEW — `presets/profiles/cadence-self.yaml` ???

Defer — Cadence's own profile is the existing `solo.yaml`. We do NOT
flip its `schemaPaths` in this PR (codex CRITICAL: "Default profile
behavior: schemaPaths: [] (empty) → no enforcement"). The README opt-in
example shows users how to enable.

### NEW — tests

- `tests/schema-changes/detectors-sql.test.ts` — every kind: CREATE /
  DROP TABLE / RENAME, ADD / DROP COLUMN, ALTER COLUMN (TYPE, SET / DROP
  NOT NULL, SET DEFAULT), ADD / DROP INDEX, ENABLE / DISABLE / FORCE RLS,
  CREATE / ALTER / DROP POLICY, GRANT / REVOKE, CREATE / ALTER / DROP
  FUNCTION, CREATE / DROP TRIGGER, CREATE / DROP VIEW, generated columns,
  ENUM additions, extensions, data ops.
- `tests/schema-changes/detectors-graphql.test.ts` — add / remove field,
  add / remove enum value, deprecate.
- `tests/schema-changes/detectors-openapi.test.ts` — add / remove
  endpoint, change response, change request.
- `tests/schema-changes/detectors-typescript.test.ts` — add / remove
  export, change signature, unchanged file → no entries.
- `tests/schema-changes/detectors-protobuf.test.ts` — add field,
  deprecate field, reserve field. Skipped gracefully if protobufjs absent.
- `tests/schema-changes/manifest-validation.test.ts` — orphan entries
  flagged; missing coverage flagged; matched diff passes.
- `tests/schema-changes/policy-enforcement.test.ts` — each policy +/-
  case (NOT NULL w/wo backfillSql, DROP COLUMN w/wo deprecation, RLS
  weakening, destructive without expandContract, pairedWith missing).
- `tests/schema-changes/pr-template-render.test.ts` — markdown table
  rendering, marker injection idempotency.
- `tests/schema-changes/cli-schema-scan.test.ts` — skeleton generation
  from a fake worktree diff.

## Dependency additions

```
"dependencies": {
  "libpg_query": "^16.x"   // Postgres-native parser
}
"optionalDependencies": {
  "graphql": "^16.x",       // GraphQL schema diff
  "protobufjs": "^7.x"      // protobuf schema diff
}
```

(TypeScript compiler API is already in `devDependencies` via `typescript`.)

## Out of scope (deferred)

- Cross-repo PR creation against `schemaConsumers`.
- Auto-fix flow that splits a destructive change into expand-contract PR pair.
- Audit log of schema changes (already covered by run-state events).
- Bugbot triage prompt tweak — the spec's §7 idea is a v8.7 follow-up; the
  bugbot phase still gets the manifest in PR body but no special triage
  rule.

## Acceptance criteria

This PR is done when:

1. `cadence schema scan` runs and prints a skeleton manifest for a worktree
   with one SQL migration + one GraphQL change.
2. `AutopilotRun.endPhase('implement', ...)` throws
   `GuardrailError('incomplete_phase_output')` when an SQL file with two
   semantic changes only has one manifest entry.
3. `endPhase` accepts the output unchanged when the profile has empty
   `schemaPaths` (back-compat).
4. The PR creation phase replaces `<!-- cadence:schema-changes -->` with
   the rendered table.
5. All five policy enforcement rules block at validate when triggered.
6. Test suite: at least 40 new test cases across the eight test files.
7. Existing tests stay green; cadence's build + audit-supabase-imports +
   audit-frontend pass.
