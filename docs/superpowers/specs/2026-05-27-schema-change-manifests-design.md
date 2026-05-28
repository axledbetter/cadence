---
title: Schema-Change Manifests — first-class implement-phase output
date: 2026-05-27
risk_tier: high
status: design
---

# Schema-Change Manifests

## Why

When cadence's implement phase touches a schema-defining artifact (SQL migration, GraphQL schema, OpenAPI spec, protobuf, published TypeScript types), agents today just write the file and ship. The downstream PR review surface a human sees is exactly the same as for any other code change — a diff. There's no:

1. **Typed manifest of what changed semantically** (added column X with default Y; renamed enum value Z to W).
2. **Additive vs destructive classification at the implement-phase boundary** (PR #226's classifier runs at the migrate phase, after implementation; by then the agent has already shipped the change).
3. **Rollback plan** captured alongside the forward migration.
4. **Consumer list** — who else depends on this contract (other repos, other services, public API clients).
5. **Expand-contract enforcement** for destructive changes (today, an agent can `DROP COLUMN` in the same PR as code reading the old shape, even though the migration classifier would warn).
6. **PR template line item** — reviewers can read a diff and miss a `NOT NULL` constraint that breaks every old client.

Schema changes are the highest-risk class of changes the implement phase can make. They deserve a first-class phase-output contract, not a postprocessor.

## Goal

If the implement phase modifies a schema-defining file (detected by glob from the profile), `phaseOutputs.implement` is **incomplete without a typed `schemaChanges[]` array** describing each change. The validate phase enforces this. The PR template renders the manifest as a structured section. The run-state engine refuses to advance past implement if the manifest is missing or contradicts the diff.

## Non-goals

- Cross-repo PR creation against consumers (the manifest carries the consumer list; opening PRs against them is a v8.7 follow-up).
- Automatic rollback execution (the manifest captures rollback SQL/diff; running it is a human decision).
- Auto-generated migrations from desired schema state (out of scope — there are dedicated tools for that, e.g. Atlas, Bytebase).
- Schema-change manifests for non-implement phases (e.g. migrate, validate — those don't author schema changes).

## Architecture

```
implement phase begins.
  ↓
Agent works in worktree.
  ↓
implement phase ends → run-lifecycle.endPhase('implement', output) called.
  ↓
output.schemaChanges[] is required if any file matching profile.schemaPaths[] was touched.
  ↓
For each touched schema file:
  Detect change type (additive | destructive | ambiguous) by AST-diffing
  the file's pre-/post-PR state.
  Require manifest entry:
    { file, kind, changes[], additive, rollback, consumers, expandContract }
  ↓
Validate phase reads phaseOutputs.implement.schemaChanges and:
  - cross-checks every entry against the actual diff (no orphan entries)
  - flags destructive changes lacking expandContract plan
  - emits PR-body snippet
  ↓
PR phase renders the manifest in the PR body via template insertion point.
  ↓
Bugbot phase reads the manifest to bias its triage (don't flag "you should
add a NOT NULL constraint" if the manifest already plans the expand step).
```

## Components

### 1. Profile schema additions (`profile.schema.json`)

```yaml
# profile.yaml
schemaPaths:                                    # globs of schema-defining files
  - data/deltas/*.sql
  - "**/*.proto"
  - "**/*.graphql"
  - openapi.{yaml,json}
  - app/types/public/**/*.ts                    # types intentionally exposed to consumers
schemaConsumers:                                # downstream dependents (repos or service IDs)
  - axledbetter/delegance-mobile
  - axledbetter/delegance-sdk
  - service:carrier-portal-automation
schemaChangePolicy:
  destructiveRequiresExpandContract: true       # default true
  blockNotNullWithoutBackfill: true             # default true
  blockDropColumnWithoutDeprecation: true       # default true
```

### 2. Manifest type (`src/core/schema-changes/types.ts`)

(Codex CRITICAL — original taxonomy under-modeled RLS/grants/functions/views/triggers, which is exactly the surface that breaks production on a Supabase repo. Expanded.)

```typescript
export type SchemaChangeKind =
  // SQL — DDL
  | 'sql.create_table'        | 'sql.drop_table'         | 'sql.rename_table'
  | 'sql.add_column'          | 'sql.drop_column'        | 'sql.alter_column'
  | 'sql.add_index'           | 'sql.drop_index'
  | 'sql.create_view'         | 'sql.alter_view'         | 'sql.drop_view'
  | 'sql.create_function'     | 'sql.alter_function'     | 'sql.drop_function'
  | 'sql.create_trigger'      | 'sql.drop_trigger'
  | 'sql.create_extension'    | 'sql.drop_extension'
  // SQL — RLS / authorization (load-bearing for Supabase)
  | 'sql.enable_rls'          | 'sql.disable_rls'        | 'sql.force_rls'
  | 'sql.add_policy'          | 'sql.alter_policy'       | 'sql.drop_policy'
  | 'sql.grant'               | 'sql.revoke'
  | 'sql.create_role'         | 'sql.alter_role'         | 'sql.drop_role'
  // SQL — data
  | 'sql.data_backfill'       | 'sql.data_delete'        | 'sql.truncate'
  // GraphQL
  | 'graphql.add_field'       | 'graphql.remove_field'   | 'graphql.add_enum_value'
  | 'graphql.remove_enum_value' | 'graphql.deprecate_field'
  // OpenAPI
  | 'openapi.add_endpoint'    | 'openapi.remove_endpoint' | 'openapi.change_response'
  | 'openapi.change_request'
  // protobuf
  | 'protobuf.add_field'      | 'protobuf.deprecate_field' | 'protobuf.reserve_field'
  // TypeScript public surface
  | 'typescript.add_export'   | 'typescript.remove_export' | 'typescript.change_signature'
  // Catch-alls
  | 'unknown.unparseable'     | 'unknown.unsupported_kind';
```

The `unknown.*` kinds (codex CRITICAL fix) are first-class so detector fallbacks can emit a manifest entry that the engine accepts but flags for manual completion.

```typescript
export interface PolicyEvidence {
  /** SQL or operation that backfills data before a destructive change. */
  backfillSql?: string;
  /** When this field/endpoint/symbol was marked deprecated. */
  deprecation?: {
    introducedIn: string;     // PR # or commit sha
    removalAfter?: string;    // earliest release that may remove it
    replacement?: string;     // pointer to the new shape
  };
  /** Free-form notes about cross-runtime compatibility. */
  compatibilityNotes?: string;
}

export interface ExpandContractEvidence {
  phase: 'expand' | 'contract';
  pairedWith?: string;                  // PR # or commit sha
  /** Required by validate: this PR's merge is gated on `pairedWith` being merged. */
  requiresMergedBefore?: string;
  /** Required by validate: backfill must be confirmed complete in prod. */
  requiresBackfillComplete?: boolean;
  /** True iff the previous-shape running code keeps working during the deployment window. */
  compatibleWithPreviousAppVersion: boolean;
  /** Which runtimes consume the schema — needed to gate concurrent old+new deploys. */
  affectedRuntimes?: Array<'nextjs-web' | 'bullmq-worker' | 'ecs-task' | 'cron' | 'lambda' | 'mobile-client' | 'external-api'>;
}

export interface SchemaChangeEntry {
  file: string;                       // path relative to repoRoot
  kind: SchemaChangeKind;
  objectName?: string;                // table.column, GraphQL type.field, etc. — used for diff matching
  operation?: string;                 // free-form qualifier (e.g. "rename A→B")
  additive: boolean;                  // computed by detector; agents can override only with explicit `additiveOverride: {reason}`
  description: string;
  rollback?: string;
  consumers?: string[];               // overrides profile.schemaConsumers for this change
  policyEvidence?: PolicyEvidence;
  expandContract?: ExpandContractEvidence;
}

export interface ImplementPhaseOutput {
  // ... existing fields ...
  schemaChanges?: SchemaChangeEntry[];
}
```

**Canonical shape** (codex WARNING — original draft had three competing names): the implement phase output carries `schemaChanges: SchemaChangeEntry[]` directly. There is no `SchemaChangeManifest` wrapper type; the array IS the manifest.

### 3. AST-diffing detectors (`src/core/schema-changes/detectors/`)

One detector per kind. Each detector is a pure function `(beforeText, afterText) => SchemaChangeEntry[]`. Detectors for the first cut:

- `sql.ts` — parse with `pg-query-emscripten` or `node-sql-parser`; produce `add_column`, `drop_column`, etc.
- `graphql.ts` — parse with `graphql` package; diff schemas.
- `openapi.ts` — parse YAML/JSON; diff paths + schemas.
- `typescript.ts` — TypeScript Compiler API; diff exported symbols' signatures from the file.
- `protobuf.ts` — `protobufjs`; diff messages.

If a touched file matches a `schemaPaths` glob but no detector exists or parsing fails, emit `{kind: 'unknown.unparseable' | 'unknown.unsupported_kind', additive: false, description: '<reason>; agent must hand-author this manifest entry'}` (kinds now first-class in `SchemaChangeKind`).

SQL parser choice: **`libpg_query` / `pg-query-parser` (Postgres-native)** rather than `node-sql-parser`. Reason: Supabase migrations use Postgres-specific syntax (RLS policies, generated columns, DO blocks, extensions, functions) that `node-sql-parser` either fails on or misclassifies. Fixture tests cover RLS, grants, functions, triggers, extensions, generated columns, enum changes (codex WARNING).

### 4. implement-phase contract change (`run-lifecycle.ts`)

(Codex WARNING — original "one entry per touched file" was too weak. Multiple semantic changes in one SQL migration each need their own entry.)

`endPhase('implement', output)` validates against the **detector output, not the file list**:

1. Compute the diff between `phaseOutputs.implement.baseSha` and `headSha` (those fields already exist in state from PR #230 — codex WARNING about persisted diff base satisfied).
2. For each file in the diff matching `profile.schemaPaths`, run the appropriate detector → produce a list of semantic changes keyed by `{file, kind, objectName, operation}`.
3. Cross-check: every detector-produced change must be matched by a manifest entry on the same `{file, kind, objectName, operation}` tuple. Mismatch → `GuardrailError(code: 'incomplete_phase_output')`.
4. Reverse-check: every manifest entry must correspond to a real detector-produced change. Orphan entries → same error.

This guarantees the manifest covers every semantic change, not just every file.

The agent (the impl subagent) is told via the skill prompt: if you touched a schema file, you owe a manifest. The skill prompt template gets a new section explaining the contract + showing an example.

For ergonomics, a `cadence schema scan` CLI verb produces the manifest skeleton from the current diff. Agents can run it and then hand-edit the `description`, `rollback`, `expandContract` fields.

### 5. validate-phase enforcement

`scripts/validate.ts` adds a `validate.schemaChanges` step. The policies now have concrete evidence to enforce against:

- `blockNotNullWithoutBackfill`: `sql.alter_column` adding NOT NULL → require `policyEvidence.backfillSql` (codex CRITICAL — was referencing a non-existent field).
- `blockDropColumnWithoutDeprecation`: `sql.drop_column` → require `policyEvidence.deprecation.introducedIn` (the PR that marked it deprecated), and `requiresMergedBefore` must reference that PR.
- `blockRlsWeakeningWithoutSecurityReview`: `sql.disable_rls` / `sql.drop_policy` / `sql.revoke` → require manual `policyEvidence.compatibilityNotes` AND fail unless the PR carries a `security-reviewed` label.
- `destructiveRequiresExpandContract`: any change with `additive: false` → require `expandContract` block AND `compatibleWithPreviousAppVersion: true` for the expand phase OR explicit `affectedRuntimes` declaration for contract phase.
- `pairedWithMustExist`: if `expandContract.pairedWith` is set, validate verifies (via `gh pr view`) that the referenced PR exists and (for contract phases) was merged.

Defense in depth: cross-check + reverse-check from the implement-phase contract run again here. Catches the case where an agent edits the manifest after endPhase.

### 6. PR template insertion

PR body template gets a `<!-- cadence:schema-changes -->` marker. The PR-creation phase renders the manifest into a markdown table at that marker.

```markdown
## Schema changes

| File | Kind | Additive | Description | Rollback |
|------|------|----------|-------------|----------|
| `data/deltas/20260527_001.sql` | sql.add_column | ✓ | Add `users.last_login_at TIMESTAMP NULL` | `ALTER TABLE users DROP COLUMN last_login_at` |

Affected consumers: `axledbetter/delegance-mobile`, `service:carrier-portal-automation` (will need to opt into reading `last_login_at` in a follow-up).
```

### 7. Bugbot-triage context

The bugbot triage step (which today only sees the diff) gets the manifest as additional context. It's told: "the agent has already declared these as schema changes; don't flag missing NOT NULL constraints if `expandContract.phase === 'expand'`."

### 8. Integration with PR #226's migration classifier

The classifier and the manifest are complementary:
- **Classifier**: determines `additive` field of `SchemaChangeEntry` for SQL files (agent can't lie about it).
- **Manifest**: requires the agent to declare `description`, `rollback`, `expandContract`, `consumers` (subjective fields the classifier can't compute).

The classifier's `migrationClassification` becomes input to the SQL detector's `additive` computation.

## Data flow (example: adding a NOT NULL column)

```
1. Spec: "Add required `birthdate` column to users table."
2. Implement phase: agent writes:
   data/deltas/20260527_001_add_users_birthdate.sql
   alter table users add column birthdate date;
   update users set birthdate = '1900-01-01' where birthdate is null;
   alter table users alter column birthdate set not null;
3. Agent calls `cadence schema scan` → skeleton:
   { file: 'data/deltas/...', kind: 'sql.add_column', additive: true,
     description: '(auto-detected: ADD COLUMN birthdate date)' }
4. Agent edits: adds rollback SQL + sets expandContract since the second
   ALTER would break old code:
   { kind: 'sql.alter_column', additive: false, expandContract:
     { phase: 'contract', pairedWith: 'PR#231' } }
5. endPhase('implement', { schemaChanges: [...] }) validates ✓.
6. validate phase checks policy:
   profile.schemaChangePolicy.blockNotNullWithoutBackfill is true.
   Manifest claims contract phase but no `pairedWith` PR exists.
   → Block. Print: "Add the expand PR (NULL column + backfill) before
      this contract PR, then re-validate."
7. Agent splits into two PRs.
```

## Error handling

- File matches `schemaPaths` glob but has no detector → warning entry; agent must hand-author the manifest.
- Manifest contradicts the diff (claims `add_column` but diff is `drop_column`) → block at validate phase.
- Manifest missing required fields for the declared kind → block at implement endPhase.
- Detector throws on malformed file (e.g. SQL parse error) → preserve the parse error; block.
- Profile lacks `schemaPaths` → no enforcement, no manifest required (back-compat).

## Testing

- `tests/schema-changes/detectors-sql.test.ts` — full taxonomy of SQL change kinds, additive vs destructive classification.
- `tests/schema-changes/detectors-graphql.test.ts`, `detectors-openapi.test.ts`, etc.
- `tests/schema-changes/manifest-validation.test.ts` — manifest required when schema file touched; orphan entries flagged; mismatched diff caught.
- `tests/schema-changes/policy-enforcement.test.ts` — `blockNotNullWithoutBackfill` etc.
- `tests/schema-changes/pr-template-render.test.ts` — markdown table generation.
- `tests/schema-changes/cadence-schema-scan.test.ts` — CLI skeleton output.

## Rollout

1. Land this PR with `schemaPaths` empty by default → no behavior change for existing users.
2. Document the opt-in flow (add `schemaPaths` to profile.yaml).
3. Cadence's own profile opts in immediately (the migration classifier from #226 already protects us; this layer makes it stronger).
4. Dashboard / delegance-app opt in as the next test customers.

## Backward compatibility

- Profiles without `schemaPaths` see no change.
- Existing implement phases that didn't write a manifest continue to work (since their globs match nothing).
- PR template marker is additive — no PR templates rendered today; they're created on opt-in.

## Out of scope

- Cross-repo PR creation against consumers (the manifest captures it; the action is a v8.7 follow-up).
- Automatic generation of expand-contract PR pairs (manifest knows the structure; auto-splitting requires the agent to be re-prompted with the constraint, which is a larger UX change).
- Schema change history / audit log (not needed for the protocol contract; if needed, the run-state engine already records it via events.ndjson).

## Post-launch follow-ups

- Detector for Rust types / Python type stubs / Java JAX-RS annotations as the user base broadens.
- Manifest-driven CHANGELOG entries (a "Schema changes" section auto-generated from manifests across all merged PRs in a release).
- Bugbot rule: if PR body's schema-changes section claims `expandContract.phase = 'expand'`, automatically open a follow-up issue for the contract PR.
