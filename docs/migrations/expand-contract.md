# Expand/Contract Migration Pattern

Rolling deploys run old code + new schema concurrently. A single
destructive migration in the same PR as the code that depends on the new
shape will break production during the rollout. The expand/contract
pattern prevents this by splitting any shape-breaking change into four
phases across multiple PRs.

## The four phases

### Phase 1 — Expand

An **additive** migration adds the new column / table / index alongside
the old shape. Old code keeps working unchanged.

Examples:

```sql
-- Phase 1: add the new column (nullable, no NOT NULL)
ALTER TABLE widgets ADD COLUMN kind_v2 text;
```

```sql
-- Phase 1: add the new index concurrently
CREATE INDEX CONCURRENTLY idx_widgets_kind_v2 ON widgets(kind_v2);
```

Ship + deploy. Verify in production observability that the old shape
keeps serving traffic.

### Phase 2 — Dual-write

Application code starts writing to BOTH the old and the new shapes (or
to only the new shape, with a backfill job for historic rows). Reads
can either prefer-new with fallback-to-old, or stay on the old shape.
This phase has no migration — it's a code-only PR.

Ship + deploy. Verify that the new shape is being populated correctly
and that backfill is complete.

### Phase 3 — Cutover

Application code switches its reads to the new shape only. The old
shape is still written (for safety), but no code path reads it.

Ship + deploy. Soak. Verify in production that no traffic depends on
the old shape.

### Phase 4 — Contract

The **destructive** migration drops the old shape. This is the only
phase that the classifier marks `destructive`.

```sql
-- @autopilot: classify=contract
-- @autopilot: contract_after=2026-06-15
-- @autopilot: contract_reason=Removing widgets.kind after v8.5.0 cutover soaked for 14 days
ALTER TABLE widgets DROP COLUMN kind;
```

The `contract_after` date pins when Phase 3 deployed. The dispatcher
(Phase 2 of issue #179) refuses contract migrations until the soak
period configured in `migrate.policy.contract_min_soak_days` has
elapsed.

Each phase is a separate PR. Autopilot refuses to land Expand + Contract
in the same PR.

## Emergency bypass

When an incident is actively in progress and the expand/contract soak
isn't possible:

```sql
-- @autopilot: classify=destructive_allowed_reason=incident=1234 hotfix for deprecated field, old shape never reached
ALTER TABLE widgets DROP COLUMN deprecated_field;
```

The reason string MUST contain either `incident=<ref>` or `PR=<ref>` and
be at least 10 characters long. Autopilot includes the bypass + reason
in the PR description so reviewers can audit.

This path is for emergencies only. The audit log distinguishes
sanctioned `classify=contract` migrations from emergency
`destructive_allowed_reason` bypasses, so review can focus on the
emergencies without drowning in routine contracts.

## What the classifier blocks

The classifier surfaces three classes of statement-level findings:

- **Destructive** — `DROP TABLE`, `DROP COLUMN`, `ALTER COLUMN TYPE`,
  `ALTER COLUMN SET/DROP NOT NULL`, `TRUNCATE`, `DELETE FROM`, RENAME
  forms, `DISABLE ROW LEVEL SECURITY`, etc. Refused outside the
  contract or emergency-bypass paths.
- **Ambiguous** — `CREATE INDEX` (non-concurrent), `CREATE POLICY`,
  `CREATE TRIGGER`, `GRANT` / `REVOKE`, `CREATE OR REPLACE
  FUNCTION/VIEW`, `ALTER TYPE`, `ADD CONSTRAINT` (validated),
  `ADD COLUMN NOT NULL` without a literal `DEFAULT`. Refused unless an
  explicit `-- @autopilot: classify=…` annotation declares intent.
- **Additive** — `CREATE TABLE`, `CREATE INDEX CONCURRENTLY`,
  `ADD COLUMN` (nullable / immutable-literal default / generated
  stored / FK reference / `NOT NULL DEFAULT <literal>`),
  `ADD CONSTRAINT NOT VALID`, `ATTACH PARTITION`, etc. Allowed.

See `src/core/migrate/classify.ts` for the full rule set.

## Why `ambiguous` blocks by default

For statements that can be safe OR unsafe depending on context
(`CREATE INDEX` on an empty vs huge table, `GRANT` to a trusted vs
untrusted role, `CREATE OR REPLACE FUNCTION` that preserves vs changes
behaviour), the classifier prefers an explicit human signal over a
guess. The `-- @autopilot: classify=additive` pin lets you document
that you've reviewed an ambiguous statement and confirmed it's safe
for the current data and traffic; the dispatcher (and Step 4.5) then
accepts it. This keeps `ambiguous` honest: the rule set never lies
about whether a statement is unambiguously safe, but the operator
gets a single-line escape hatch when context makes it safe.
