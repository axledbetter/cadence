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
- `PolicyEvidence { backfillSql?, deprecation?, compatibilityNotes?,
  securityReview? }` — **codex CRITICAL fix**: added
  `securityReview: { reviewer, notes, approvedAt? }` so
  `blockRlsWeakeningWithoutSecurityReview` has a concrete evidence slot.
- `ExpandContractEvidence { phase, pairedWith?, requiresMergedBefore?,
  requiresBackfillComplete?, compatibleWithPreviousAppVersion,
  affectedRuntimes? }`.
- `SchemaChangeEntry { file, kind, objectName?, subObjectName?,
  statementIndex?, operation?, additive, description, rollback?,
  consumers?, policyEvidence?, expandContract? }` — **codex CRITICAL fix**:
  added `subObjectName` (e.g. column name on a table) and `statementIndex`
  to guarantee per-semantic-change uniqueness. Matching uses multiset
  equality on `{file, kind, objectName, subObjectName, statementIndex?,
  operation?}` — two identical statements still need two manifest entries.

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

Uses the TypeScript Compiler API. **Codex WARNING fix** — `typescript` is
listed as `devDependency` in package.json today but cadence ships as an
npm package; consumers `npm install`-ing cadence already install
`typescript` transitively via `tsx`. We **lazy-import** `typescript` via
`await import('typescript')` and on failure emit a single
`unknown.unsupported_kind` entry per file (no hard runtime dependency
added). For each file, parse both texts as `ts.SourceFile`, list exported
symbols by name, hash each export's printed text. New name →
`typescript.add_export`; removed → `typescript.remove_export`; changed
hash → `typescript.change_signature`.

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

### NEW — `src/core/schema-changes/diff-provider.ts` (codex WARNING fix)

Shared diff abstraction so the lifecycle path and the CLI scan use the
same code:

```typescript
export interface DiffEntry { path: string; status: 'added' | 'deleted' | 'modified' | 'renamed'; beforeText?: string; afterText?: string; }
export interface DiffProvider {
  collectChangedFiles(opts: { baseRef: string; includeUntracked?: boolean }): Promise<DiffEntry[]>;
}
export function makeGitDiffProvider(repoRoot: string): DiffProvider;
```

Implementation shells `git diff --name-status <baseRef>` and
`git show <baseRef>:<path>` for `before`; reads `afterText` from disk
(or empty for deletes). Detectors handle `beforeText === undefined`
(add) and `afterText === undefined` (delete) explicitly.

### NEW — `src/core/schema-changes/validator.ts`

Pure functions, no IO:

- `crossCheckManifest({ manifest, detected })` — **multiset** match on
  `{file, kind, objectName, subObjectName, statementIndex?, operation?}`.
  Two detected ADD COLUMN statements on the same table need two manifest
  entries (codex CRITICAL fix). Mismatch → list of issues.
- `reverseCheck({ manifest, detected })` — every manifest entry must
  match a detected change (or carry `additiveOverride` reason).
- `enforcePolicy({ manifest, policy })` — `blockNotNullWithoutBackfill`,
  `blockDropColumnWithoutDeprecation`, `blockRlsWeakeningWithoutSecurityReview`
  (requires `policyEvidence.securityReview.reviewer`),
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

Mirror the new fields. `schemaPaths` items are strings (globs).
`schemaPaths` defaults to `[]` (opt-in gate). **Codex WARNING fix —
defaults must agree with TypeScript**: once a profile sets a non-empty
`schemaPaths`, the `schemaChangePolicy` boolean defaults are all `true`
(safe by default). The JSON schema documents the per-field default; the
TypeScript resolver applies the same default in code (JSON Schema
draft-07 defaults are annotation-only).

### EDIT — `src/core/autopilot/run-lifecycle.ts`

`endPhase('implement', output)`: **codex CRITICAL fix** — gate ALL
enforcement on `profile.schemaPaths.length > 0`. When the profile has not
opted in, accept `output.schemaChanges` as-is (only basic shape validation
via `validateImplement`). When opted in, lazy-import detector dispatch and
run cross-check + reverse-check. Detectors require a diff provider; we
inject one via dependency injection (`opts.diffProvider`) so tests can
stub it. The lifecycle file stays free of detector imports.

Throws `GuardrailError` with the new dedicated `incomplete_phase_output`
code (not reusing `invalid_config`).

### EDIT — `src/core/errors.ts`

Add `'incomplete_phase_output'` and `'schema_policy_violation'` to
`ErrorCode`. Default `retryable: false`. Policy violations get their own
code so callers can distinguish "manifest doesn't cover the diff"
(incomplete) from "manifest entries violate policy" (validate-phase block).

### EDIT — `src/cli/validate.ts` (codex CRITICAL fix — wire policy enforcement)

The validate-phase wrap loads the previously-persisted implement-phase
`schemaChanges` from `runDir/artifacts/implement.json`, reads
`profile.schemaChangePolicy`, runs `enforcePolicy()`, and emits an
explicit block (non-zero exit + `GuardrailError('schema_policy_violation')`)
on any blocker-severity issue. Gated on `profile.schemaPaths.length > 0`.

### EDIT — PR body assembly (codex CRITICAL fix — wire template injection)

Find the existing PR body builder (search for the PR template literal in
`src/cli/pr.ts` or wherever the body is composed). After the body is
assembled, call `injectIntoPrBody(body, schemaChanges)` so the
`<!-- cadence:schema-changes -->` marker is replaced with the rendered
table. The PR phase reads `schemaChanges` from the latest implement-phase
artifact. If no manifest exists, the marker is stripped (leaving a clean
PR body for opt-out users).

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
"optionalDependencies": {
  "libpg_query": "^17.x",   // Postgres-native parser — optional so cadence install stays cheap on machines without compilers
  "graphql": "^16.x",       // GraphQL schema diff
  "protobufjs": "^7.x"      // protobuf schema diff
}
```

All detectors lazy-import their parser and fall back to
`unknown.unsupported_kind` when the package is absent. This keeps
`npm install @delegance/cadence` light on non-opted-in users and avoids
native-build failures on minimal images. **Codex NOTE fix** — the smoke
test `tests/schema-changes/detectors-sql.test.ts` verifies `libpg_query`
loads under Node 22 in the cadence test environment; downstream consumers
(e.g. delegance-app on Alpine ECS) need to validate the same in their own
Docker base image as part of opting in.

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
