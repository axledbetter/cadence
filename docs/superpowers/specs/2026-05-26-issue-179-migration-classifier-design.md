---
title: Expand/Contract Migration Safety — Additive vs Destructive Classifier
risk: high
issue: 179
codex_passes_completed: 3
---

# Spec: Migration classifier (additive vs destructive)

## Why

v7.9.1 fixed migrate-before-validate sequencing. It did NOT address the deeper
safety issue Codex flagged on that PR: even with perfect sequencing, **rolling
deploys run old code + new schema concurrently**. A single `DROP COLUMN` or
`ALTER COLUMN ... DROP NOT NULL` in the same PR as the code that depends on
the new shape is unsafe regardless of when the migration fires.

Today the cadence package has no classification at all:
- `ResultArtifact.destructiveDetected: boolean` is hardcoded `false` in
  `src/core/migrate/dispatcher.ts:171,289` (the two synthesis paths).
- Skills MAY set it, but the dispatcher doesn't, and no skill in the package
  actually does.
- Delegance's `scripts/supabase/validate.ts` has a weak regex check that only
  catches `DROP TABLE | DROP COLUMN | TRUNCATE`. It misses `ALTER COLUMN ...
  TYPE`, `ALTER COLUMN ... DROP NOT NULL`, `RENAME`, and a dozen other shape-
  breaking shapes.

This spec lands a real classifier inside the `@delegance/cadence` package
and wires it as a **mandatory dispatcher pre-flight** so every consumer of
`migrate@1` / `migrate.supabase@1` gets the same safety gate without
opting in. The autopilot Step 4.5 hook is the human-readable surface;
the dispatcher-level enforcement is the load-bearing safety guarantee
when consumers invoke the migrate skill directly (without autopilot).

## Implementation scope split

This spec describes the full target: classifier + CLI + autopilot Step 4.5
+ dispatcher pre-flight + contract workflow + manifest format. To stay
within a single PR's reviewable size, the implementation is split:

- **This PR (#179, Phase 1):** classifier (`classify.ts`), CLI verb
  (`cadence migrate classify --file=<path>`), autopilot Step 4.5 hook,
  `docs/migrations/expand-contract.md`, full test suite for the
  classifier and CLI. The classifier is conservative-by-default (any
  `ambiguous` blocks unless pinned) and ships the bypass grammar with
  validation. **Dispatcher pre-flight enforcement is NOT wired in this
  PR**; sections 4 (dispatcher enforcement), `MigrationClassification`
  result-artifact field, `list-pending` skill verb, and
  `migrations.manifest.json` are documented here as the target shape but
  deferred to a Phase 2 follow-up issue.
- **Follow-up (Phase 2, separate issue):** dispatcher pre-flight
  enforcement, `MigrationClassification` field, `list-pending` skill
  verb, manifest format + `cadence migrate manifest --emit`,
  policy keys (`allow_contract`, `contract_min_soak_days`,
  `allow_emergency_bypass`). This Phase 2 is what makes the safety
  guarantee load-bearing for non-autopilot consumers.

Rationale for the split: Phase 1 gives autopilot users (the only known
consumer today) the full safety gate via Step 4.5, AND publishes the
public API (`classify()`, CLI verb, annotation grammar) that Phase 2
will wire into the dispatcher. Phase 2 is then a behind-the-scenes
plumbing change that doesn't need to redesign the classifier or
annotations. The total cost is the same; the PRs are reviewable in
isolation.

## Scope decision — Option A (hand-rolled, no parser dep)

The issue offers three options:

- **(A)** Hand-rolled regex/pattern classifier (~150 LOC), reasonable accuracy
  for obvious cases.
- **(B)** Real SQL parser dep (`pg-query-emscripten`, `node-sql-parser`) — more
  accurate, adds a runtime dep.
- **(C)** Spec only.

**Chosen: A.** Rationale:

1. **Lean-deps philosophy.** Cadence's current runtime dep surface is 11
   packages (`ajv`, `ajv-formats`, `canonicalize`, `dotenv`, `js-yaml`,
   `minimatch`, `proper-lockfile`, `shell-quote`, `supabase`, `tsx`,
   `ulid`). `pg-query-emscripten` is a 5–10 MB WASM blob; `node-sql-parser`
   pulls in a 2 MB AST library and a parser-generator runtime. Neither is
   warranted for the DDL surface we actually need to classify.
2. **The DDL classification surface is small and well-anchored.** Every
   destructive statement starts with a small set of stable keywords
   (`DROP`, `TRUNCATE`, `DELETE FROM`, `ALTER TABLE … ALTER COLUMN …`,
   `ALTER TABLE … RENAME …`). The grammar around those keywords is rigid
   in Postgres dialect. A statement-splitter + pattern-matcher captures
   every case in the issue's acceptance list with high confidence.
3. **Fail-safe is built-in.** The classifier defaults `ambiguous` →
   `destructive` (refuse). Any statement the pattern matcher can't classify
   into `additive` falls into `ambiguous`, which the policy treats as
   destructive unless the SQL file has an explicit annotation. So the
   correctness bound is **lower-bounded by the conservative default**, not
   by the accuracy of the additive-detection patterns.
4. **Easy to upgrade later.** The classifier interface is a single function
   `classify(sql: string): ClassificationResult`. If we ever need true AST
   accuracy (e.g. for very complex `ALTER TABLE` chains with mixed clauses),
   we can swap the engine without changing call sites.

If A proves insufficient in practice — false-positive `ambiguous` rate too
high in real Delegance migrations — we revisit B as a follow-up issue. Today,
the false-positive direction (ambiguous → destructive → blocked PR) is the
safe one. False-negatives (destructive classified as additive) are the
dangerous direction, and the conservative pattern matcher does not produce
those for any statement on the issue's acceptance list.

## Components

### 1. `src/core/migrate/classify.ts` (new — ~350 LOC)

Public API:

```ts
export type StatementClass = 'additive' | 'destructive' | 'ambiguous';
export type PinnedAs =
  | 'additive'
  | 'destructive'
  | 'expand'
  | 'contract'
  | null;

export interface StatementClassification {
  /** Trimmed SQL of the statement (single statement, no trailing semicolon). */
  sql: string;
  /** 1-based line number of the first non-comment, non-whitespace char. */
  startLine: number;
  /** Classification of THIS statement (file-level result is the max-severity reduce). */
  classification: StatementClass;
  /** Stable matched-rule id (e.g. 'drop-table', 'alter-column-type'). */
  rule: string;
  /** Human-readable reason — surfaced to the user in CLI output. */
  reason: string;
}

export interface FileAnnotation {
  /**
   * Raw annotation value:
   * `additive` | `destructive` | `expand` | `contract`
   * | `destructive_allowed_reason=<rationale>`
   */
  classify?: string;
  /** Free-form reason text after `destructive_allowed_reason=`. */
  destructiveAllowedReason?: string;
  /** ISO-8601 date string from `-- @autopilot: contract_after=YYYY-MM-DD`. */
  contractAfter?: string;
  /** Free-form text from `-- @autopilot: contract_reason=...`. */
  contractReason?: string;
}

export interface ClassificationResult {
  /** File-level reduce: max severity across statements
   *  (destructive > ambiguous > additive). */
  classification: StatementClass;
  /** Per-statement classifications in source order. */
  statements: StatementClassification[];
  /** Parsed `-- @autopilot:` annotation block, if present. */
  annotation: FileAnnotation | null;
  /**
   * True when an `ambiguous` file reduce is "pinned" by a recognised
   * `classify=additive|destructive|expand|contract` annotation. The
   * file reduce is NOT changed by pinning — only the CLI exit code is.
   */
  pinned: boolean;
  /** When `pinned`, the recognised label. */
  pinnedAs: PinnedAs;
  /** True if the annotation explicitly bypasses a destructive file
   *  (`classify=destructive_allowed_reason=...`). */
  bypassed: boolean;
  /** When `bypassed`, the reason text. */
  bypassReason: string | null;
}

export function classify(sql: string): ClassificationResult;
```

Implementation:

1. **Single-pass lexer** — walk the SQL string once, tracking lexer
   state: `default`, `line-comment` (`--` to `\n`), `block-comment`
   (`/*` to `*/`, nestable per Postgres), `single-quote` (`'…'`,
   handling `''` escapes and `E'…\…'` C-style escapes),
   `double-quote` (quoted identifier `"…"`), `dollar-quote` (`$tag$
   … $tag$` where `tag` is an optional identifier — content is opaque
   including `--` and `/*` inside the body). Emit a list of tokens
   tagged with state. This avoids the comment-stripping-then-split
   foot-gun where `--` inside a string literal corrupts the split.
2. **Statement split** — using the lexer output, split at `;` tokens
   that appear in `default` state with paren-depth 0. Preserve line
   numbers via the token offsets.
3. **Annotation extraction** — scan the leading comment block
   (everything between BOF and the first `default`-state non-whitespace
   token) for `-- @autopilot: classify=<value>` lines (line comments
   only — block comments are not searched for the annotation, to
   avoid accidental matches inside PL/pgSQL bodies that begin a file).
   Parse into `FileAnnotation`. Annotation is per-FILE; only the
   leading block counts.
4. **Per-statement classify** — run the pattern matchers (next
   section) against each statement's `default`-state text (the lexer
   already stripped comments). Default: `ambiguous`.
5. **File reduce** — `destructive` if any statement is destructive;
   else `ambiguous` if any is ambiguous; else `additive`.
6. **Annotation interpretation:**
   - `classify=destructive_allowed_reason=<reason>`:
     `bypassed=true`, `bypassReason=<reason>`. The file reduce stays
     as-is (still `destructive`), but the CLI surfaces the bypass and
     the exit code is `0`.
   - `classify=additive` / `expand` AND file reduce is `ambiguous`:
     `pinned=true`, `pinnedAs=<label>`. CLI exit `0`.
   - `classify=destructive` AND file reduce is `ambiguous`:
     `pinned=true`, `pinnedAs='destructive'`. CLI exit `1`.
   - `classify=contract` — sanctioned contract intent label.
     Recognised in TWO cases:
     * file reduce is `ambiguous` → `pinned=true`,
       `pinnedAs='contract'`, CLI exit `1`.
     * file reduce is `destructive` → `pinned=true`,
       `pinnedAs='contract'`, CLI exit `1`. The file is still
       classified `destructive` (truthful) but the dispatcher uses
       `pinnedAs='contract'` plus `policy.allow_contract` to gate
       acceptance. This is the load-bearing rule that makes Phase 4
       contract migrations applyable WITHOUT misusing the emergency
       bypass.
   - All other combinations: annotation is documentation; file reduce
     drives the result.

### 2. Rule set

The classifier normalizes each statement before rule matching:

- Collapse runs of whitespace to single spaces.
- Strip optional `IF EXISTS` / `IF NOT EXISTS` / `ONLY` tokens so the
  rules don't need to repeat them.
- Recognise schema-qualified identifiers (`schema.name`) and
  double-quoted identifiers (`"schema"."name"`) — names are matched by
  a shared `IDENT` token, not raw `\S+`. This avoids
  `ALTER TABLE IF EXISTS public.widgets DROP COLUMN IF EXISTS kind`
  falling through to ambiguous on a real Postgres form.

**`ALTER TABLE` is its own pipeline (not a flat regex).** Because
`ALTER TABLE foo ADD COLUMN a int, DROP COLUMN b` mixes additive and
destructive clauses in one statement, the `alter-table` classifier:

1. Parses the table-name prefix
   (`ALTER TABLE [IF EXISTS] [ONLY] <ident>`).
2. Splits the remaining text on top-level `,` (respecting parens and
   string literals from the lexer pass).
3. Classifies each clause via the per-clause `ALTER TABLE` rules.
4. Reduces clause severities (any-destructive → destructive,
   any-ambiguous → ambiguous, all-additive → additive) for the
   statement-level result.

The reduce ensures `ADD COLUMN a int, DROP COLUMN b` is destructive
even when the matcher sees the additive clause first.

`ADD COLUMN` clauses are handled by a dedicated function
(`classifyAddColumnClause`) that inspects the column constraint list:

- nullable (no `NOT NULL`) → additive
- `NOT NULL DEFAULT <expr>` → additive (Postgres backfills with the
  default atomically)
- `NOT NULL` with no `DEFAULT` → ambiguous (`add-column-not-null-no-default`)
- `NOT NULL GENERATED ALWAYS AS …` (generated stored column) → additive
- column has `REFERENCES` only → additive (the FK constraint is
  additive; only `DROP CONSTRAINT` on an existing FK is destructive)

Per-clause `ALTER TABLE` rules (clauses are matched against the post-
table-name text):

| id | severity | clause pattern | reason |
|----|---|---|---|
| `drop-column` | destructive | `DROP COLUMN [IF EXISTS] <IDENT>` | `DROP COLUMN removes a column from existing rows` |
| `drop-constraint` | destructive | `DROP CONSTRAINT [IF EXISTS] <IDENT>` | `DROP CONSTRAINT removes a check / FK / unique guarantee` |
| `alter-column-type` | destructive | `ALTER COLUMN <IDENT> (SET DATA )?TYPE` | `ALTER COLUMN ... TYPE changes the shape; old readers/writers will break` |
| `alter-column-drop-not-null` | destructive | `ALTER COLUMN <IDENT> DROP NOT NULL` | `DROP NOT NULL relaxes a guarantee old readers may rely on` |
| `alter-column-set-not-null` | destructive | `ALTER COLUMN <IDENT> SET NOT NULL` | `SET NOT NULL on a column with existing nulls aborts; old writers may also fail` |
| `alter-column-drop-default` | destructive | `ALTER COLUMN <IDENT> DROP DEFAULT` | `DROP DEFAULT can break INSERTs relying on the default` |
| `rename-column` | destructive | `RENAME (COLUMN )?<IDENT> TO <IDENT>` | `RENAME COLUMN breaks references to the old name` |
| `rename-constraint` | destructive | `RENAME CONSTRAINT <IDENT> TO <IDENT>` | `RENAME CONSTRAINT breaks references by name` |
| `set-schema` | destructive | `SET SCHEMA <IDENT>` | `SET SCHEMA moves the table to another namespace; old refs break` |
| `disable-rls-clause` | destructive | `DISABLE ROW LEVEL SECURITY` | `DISABLE RLS exposes a previously-protected table` |
| `enable-rls-clause` | ambiguous | `ENABLE ROW LEVEL SECURITY` | `ENABLE RLS can deny live traffic if policies are incomplete` |
| `force-rls-clause` | ambiguous | `FORCE ROW LEVEL SECURITY` | `FORCE RLS changes RLS bypass behaviour for table owners` |
| `add-column` | dispatched | `ADD COLUMN <IDENT> <TYPE> <CONSTRAINTS…>` | (per `classifyAddColumnClause`) |
| `add-constraint-not-valid` | additive | `ADD CONSTRAINT <IDENT> ... NOT VALID` | `ADD CONSTRAINT NOT VALID skips validation; safe to add` |
| `add-constraint` | ambiguous | `ADD CONSTRAINT <IDENT> ...` (without NOT VALID) | `Validated ADD CONSTRAINT can fail on existing data and lock-heavy; prefer NOT VALID + later VALIDATE` |
| `validate-constraint` | ambiguous | `VALIDATE CONSTRAINT <IDENT>` | `VALIDATE CONSTRAINT can be slow on large tables` |
| `attach-partition` | additive | `ATTACH PARTITION <IDENT>` | `ATTACH PARTITION is additive` |

**Reclassifications based on rolling-deploy reality** — several DDL forms
are NOT safely additive in this stack:

- `CREATE INDEX` (non-concurrent) → ambiguous (long write lock on large
  tables). Only `CREATE INDEX CONCURRENTLY` is additive.
- `CREATE UNIQUE INDEX` (non-concurrent) → destructive (locks + can fail
  if duplicates exist). `CREATE UNIQUE INDEX CONCURRENTLY` → ambiguous
  (can fail mid-build; needs a follow-up `VALIDATE`-style check, see
  Postgres docs).
- `CREATE TRIGGER` → ambiguous (changes write behaviour for live
  traffic instantly).
- `ADD CONSTRAINT` (validated) → ambiguous (CHECK / FK validation can
  fail on existing data; lock-heavy). `ADD CONSTRAINT ... NOT VALID`
  → additive (Postgres skips validation; safe to add).
- `GRANT` → ambiguous (broadens access; can leak data via misissued
  grants in an RLS-on-all-tables stack).
- `CREATE POLICY` (PERMISSIVE) → ambiguous in the Delegance/Supabase
  RLS-on-all-tables context, despite the technical fact that PERMISSIVE
  policies UNION with existing rules. Reason: a misissued permissive
  policy can broaden access across tenants; the safety bar for RLS
  changes is "require human review", not "auto-approve."
- `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` → destructive (exposes
  a previously-protected table; this is a direct security regression in
  the stack). Promoted from ambiguous.
- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` → ambiguous (can deny
  live traffic if no SELECT policy exists).
- `ADD COLUMN <name> <type> NOT NULL DEFAULT <expr>` — additive ONLY
  when `<expr>` is an immutable literal (`0`, `'string'`, `true`,
  `false`, `null`-but-then-it's-not-NOT-NULL, `current_timestamp` is
  STABLE not immutable — ambiguous). Volatile defaults
  (`gen_random_uuid()`, `now()`, `random()`, function calls in general)
  → ambiguous (Postgres rewrites the table on the default, which can
  be a long lock on large tables).

The classifier ships an `IMMUTABLE_LITERAL` regex for the default check:
matches `^(NULL|TRUE|FALSE|-?[0-9]+(\.[0-9]+)?|'[^']*'|E'[^']*')$`
(post-normalisation). Anything more complex → ambiguous.

Top-level (non-`ALTER TABLE`) **destructive rules:**

| id | pattern (start-of-statement, after normalisation) | reason |
|----|---|---|
| `drop-table` | `DROP TABLE` | `DROP TABLE removes a table and all its data` |
| `drop-index` | `DROP INDEX` | `DROP INDEX removes a query-acceleration structure` |
| `drop-view` | `DROP VIEW` | `DROP VIEW removes a queryable view` |
| `drop-materialized-view` | `DROP MATERIALIZED VIEW` | `DROP MATERIALIZED VIEW removes a cached query result` |
| `drop-function` | `DROP FUNCTION` | `DROP FUNCTION removes a callable function` |
| `drop-procedure` | `DROP PROCEDURE` | `DROP PROCEDURE removes a callable procedure` |
| `drop-policy` | `DROP POLICY` | `DROP POLICY removes an RLS policy; could expose or deny existing traffic` |
| `drop-trigger` | `DROP TRIGGER` | `DROP TRIGGER removes a row-level hook` |
| `drop-schema` | `DROP SCHEMA` | `DROP SCHEMA removes an entire namespace` |
| `drop-type` | `DROP TYPE` | `DROP TYPE removes a user-defined type` |
| `drop-sequence` | `DROP SEQUENCE` | `DROP SEQUENCE removes an ID generator` |
| `drop-extension` | `DROP EXTENSION` | `DROP EXTENSION removes a Postgres extension and its objects` |
| `drop-domain` | `DROP DOMAIN` | `DROP DOMAIN removes a constrained type` |
| `truncate` | `TRUNCATE` | `TRUNCATE deletes all rows in a table` |
| `delete-from` | `DELETE FROM` | `DELETE FROM in a migration is data-destructive (DML in DDL)` |
| `alter-table-rename-to` | `ALTER TABLE <IDENT> RENAME TO` | `RENAME TABLE breaks all references to the old name` |
| `disable-rls` | `ALTER TABLE <IDENT> DISABLE ROW LEVEL SECURITY` | `DISABLE RLS exposes a previously-protected table — direct security regression in an RLS-by-default stack` |

(Note: `RENAME COLUMN` / `RENAME CONSTRAINT` are handled inside the
`ALTER TABLE` pipeline; `RENAME TO` at the table level is the
table-rename form.)

Top-level **additive rules:**

| id | pattern | reason |
|----|---|---|
| `create-table` | `CREATE TABLE` (incl. `IF NOT EXISTS`) | `CREATE TABLE adds a new table` |
| `create-index-concurrently` | `CREATE INDEX (IF NOT EXISTS )?CONCURRENTLY` (non-unique) | `CREATE INDEX CONCURRENTLY is safe for live traffic` |
| `create-view` | `CREATE VIEW` | `CREATE VIEW adds a queryable view` |
| `create-materialized-view` | `CREATE MATERIALIZED VIEW` | `CREATE MATERIALIZED VIEW adds a cached query result` |
| `create-function` | `CREATE FUNCTION` (no `OR REPLACE`) | `CREATE FUNCTION adds a callable function` |
| `create-procedure` | `CREATE PROCEDURE` (no `OR REPLACE`) | `CREATE PROCEDURE adds a callable procedure` |
| `create-schema` | `CREATE SCHEMA` | `CREATE SCHEMA adds a namespace` |
| `create-extension` | `CREATE EXTENSION` | `CREATE EXTENSION adds a Postgres extension` |
| `create-type` | `CREATE TYPE` | `CREATE TYPE adds a user-defined type` |
| `create-sequence` | `CREATE SEQUENCE` | `CREATE SEQUENCE adds an ID generator` |
| `create-domain` | `CREATE DOMAIN` | `CREATE DOMAIN adds a constrained type` |
| `comment-on` | `COMMENT ON` | `COMMENT ON sets metadata only` |

Top-level **ambiguous rules:**

| id | pattern | reason |
|----|---|---|
| `create-index-nonconcurrent` | `CREATE INDEX` (no CONCURRENTLY, non-unique) | `Non-concurrent CREATE INDEX holds a write lock; long on large tables` |
| `create-unique-index-concurrent` | `CREATE UNIQUE INDEX (IF NOT EXISTS )?CONCURRENTLY` | `Concurrent unique index can fail if duplicates exist; needs manual VALIDATE` |
| `create-policy` | `CREATE POLICY` (any form) | `CREATE POLICY changes RLS semantics in an RLS-on-all-tables stack; requires human review` |
| `create-policy-restrictive` | `CREATE POLICY ... AS RESTRICTIVE` | `RESTRICTIVE policies AND with existing rules; can reduce access for live traffic` |
| `alter-policy` | `ALTER POLICY` | `ALTER POLICY can change tenancy semantics (USING / WITH CHECK)` |
| `create-trigger` | `CREATE TRIGGER` | `CREATE TRIGGER changes write behaviour for live traffic instantly` |
| `create-or-replace-function` | `CREATE OR REPLACE FUNCTION` | `CREATE OR REPLACE FUNCTION can change behaviour relied on by old code, triggers, or policies` |
| `create-or-replace-procedure` | `CREATE OR REPLACE PROCEDURE` | `CREATE OR REPLACE PROCEDURE can change behaviour relied on by old callers` |
| `create-or-replace-view` | `CREATE OR REPLACE VIEW` | `CREATE OR REPLACE VIEW can change result shape; existing readers may break` |
| `grant` | `GRANT` | `GRANT broadens access; in an RLS-on-all-tables stack a misissued grant can leak data` |
| `revoke` | `REVOKE` | `REVOKE removes existing permission; could deny live traffic` |
| `alter-type` | `ALTER TYPE` | `ALTER TYPE (add/rename enum value, etc.) can break old readers depending on the change` |

Anything not matched is `ambiguous` with rule `unknown-statement` and
reason "Unrecognised DDL — classify=additive or destructive annotation
required to proceed."

### 3. CLI verb: `cadence migrate classify --file=<path>`

Add to `src/cli/migrate.ts` a new subcommand `classify` that:

1. Reads the file at `--file`.
2. Calls `classify(sql)`.
3. Emits JSON to stdout:

```json
{
  "file": "data/deltas/20260526000000_add_widget_kind.sql",
  "classification": "destructive",
  "pinned": false,
  "pinnedAs": null,
  "bypassed": false,
  "bypassReason": null,
  "annotation": { "classify": null },
  "statements": [
    {
      "sql": "ALTER TABLE widgets DROP COLUMN kind",
      "startLine": 3,
      "classification": "destructive",
      "rule": "drop-column",
      "reason": "DROP COLUMN removes a column from existing rows"
    }
  ]
}
```

4. Exit codes:
   - `0` — File is safe to apply (one of):
     - `classification === 'additive'`, OR
     - `bypassed === true` (any classification + valid
       `destructive_allowed_reason`), OR
     - `classification === 'ambiguous'` AND
       `pinnedAs` in `['additive', 'expand']`.
   - `1` — File requires expand/contract treatment (one of):
     - `classification === 'destructive'` and not bypassed, OR
     - `classification === 'ambiguous'` AND
       `pinnedAs` in `['destructive', 'contract']`.
   - `2` — File needs an explicit annotation:
     - `classification === 'ambiguous'` AND `pinnedAs === null`.

The CLI also supports `--format=human` for a terminal-friendly view (per-
statement table with severity, rule, reason).

### 4. Dispatcher pre-flight enforcement (load-bearing)

Modify `src/core/migrate/dispatcher.ts` so the `dispatch()` flow runs a
classifier pre-flight BEFORE the policy / handshake / executor steps
when the resolved skill is `migrate@1` or `migrate.supabase@1`.

#### Pending-migration discovery

The classifier MUST only see files that are about to be applied — not
the whole history. Otherwise, an already-applied destructive contract
would re-block every future deploy. The dispatcher uses a layered
discovery strategy:

1. **Preferred (skill-cooperative):** if the skill supports a
   `list-pending` verb (new optional skill capability), invoke it via
   the envelope shim with `mode=list-pending` and read back a JSON
   array of pending file paths. `migrate.supabase@1` ships with this
   verb in the same PR; `migrate@1` is required to implement it ONLY
   if the consumer configures the new
   `stackMd.migrate.classify_pending_from: skill | git | none` key.
2. **Fallback (git PR-diff):** if `envelope.gitBase` and HEAD resolve
   in a real git tree, derive pending files as
   `git diff --name-only --diff-filter=AM <gitBase>...HEAD --
   <deltas_dir>`. Suitable for the PR-time enforcement path
   (autopilot Step 4.5, CI on a PR branch).
3. **Fallback (manifest):** if neither (1) nor (2) is available
   (e.g. ECS/Docker prod with no `.git` baked in), read a
   `.autopilot/migrations.manifest.json` file at the repo root listing
   the migrations introduced in this image build. The manifest is
   produced at build time by `cadence migrate manifest --emit` (new
   subcommand, ships alongside `classify`) and contains
   `{ "introduced": ["<file>", ...] }`. The dispatcher classifies only
   the listed files.
4. **Last resort:** if none of (1)–(3) is available, the dispatcher
   FAILS CLOSED with reason code
   `pending-discovery-unavailable`. It does NOT default to "classify
   the whole history" (that was the original spec — it would block
   real ECS deploys with historical destructive migrations) and it
   does NOT default to "no-op classify" (that's a silent safety bypass).
   The operator is required to choose: bake the manifest into the
   image, ship the skill `list-pending` verb, or use the git fallback.

Pending discovery is per-skill:
- `migrate.supabase@1` → uses `stackMd.migrate.supabase.deltas_dir`,
  plus the `list-pending` verb shipped in this PR (reads the supabase
  ledger).
- `migrate@1` → uses `stackMd.migrate.deltas_dir` (new optional
  field). If the host project's tool exposes a "show pending"
  command, the operator wires that into `list-pending` themselves;
  otherwise they rely on the git-diff fallback or the manifest.
- `none@1` → no-op classifier (skill is a no-op by design).

#### Per-file enforcement

For each pending file, call `classify(sql)`. Decision matrix:

| File state | Dispatcher behaviour |
|---|---|
| `additive` | continue |
| `bypassed: true` (emergency `destructive_allowed_reason`) | continue, audit logs the bypass reason; runtime warns |
| `destructive` (no bypass) AND env is `dev` AND `policy.allow_contract_in_dev: true` | continue (dev is the verification env for contract migrations; gate stays on for qa/prod) |
| `destructive` (no bypass) otherwise | fail closed with reason `destructive-migration-blocked` |
| `ambiguous` + `pinnedAs in [additive, expand]` | continue |
| `ambiguous` + `pinnedAs in [destructive, contract]` | same as `destructive` |
| `ambiguous` + `pinnedAs === null` | fail closed with reason `ambiguous-migration-needs-annotation` |

#### Sanctioned contract workflow (not an emergency bypass)

Section 8 documents the normal Phase 4 (contract) workflow. The
classifier annotation grammar provides a dedicated path:

```sql
-- @autopilot: classify=contract
-- @autopilot: contract_after=2026-06-15
-- @autopilot: contract_reason=Removing widgets.kind after v8.5.0 cutover soaked for 14 days
ALTER TABLE widgets DROP COLUMN kind;
```

When `classify=contract` is set, the classifier returns
`pinnedAs='contract'` and the dispatcher gates on a new policy block:

```yaml
migrate:
  policy:
    allow_contract: true        # CI explicitly opts the env in
    contract_min_soak_days: 7   # contract_after must be at least this old
```

`allow_contract` defaults to `false` (refuse). When `true`, the
dispatcher accepts `pinnedAs='contract'` files as long as
`contract_after` is set AND `Date.now() - contract_after >=
contract_min_soak_days days`. Audit log records:
`contract-migration-accepted:<file>:after=<date>`.

Emergency bypass (`destructive_allowed_reason`) is reserved for the
"can't follow the soak — incident in progress" path and is logged
separately. The two paths are distinguishable in audit so review can
focus on emergency bypasses without drowning in routine contracts.

#### Bypass annotation validation

The classifier validates the `destructive_allowed_reason` text:
- non-empty (trimmed, ≥ 10 chars)
- contains either `incident=` or `PR=` reference token (free-form
  after the `=`; the validator just checks the substring is present)

A missing or too-short reason demotes the file to plain `destructive`
(no bypass) — i.e. the file is still blocked. Reason: a one-line "fix
later" is too easy a copy-paste; the incident or PR reference token
forces the operator to anchor the bypass to a traceable event.

#### Result artifact propagation

A new optional field on `ResultArtifact`:

```ts
export interface MigrationClassification {
  destructiveDetected: boolean;
  ambiguousDetected: boolean;
  bypasses: Array<{ file: string; reason: string }>;
  contracts: Array<{ file: string; after: string; reason: string }>;
}
```

- On the synthetic blocked-error path, `destructiveDetected` is set
  and `migrationClassification` is included.
- On the success path (file classified `additive` / `bypassed` /
  `contract`), the dispatcher MERGES `migrationClassification` into
  the skill's returned artifact (using a shallow merge that does not
  clobber skill-set fields). Observability consumers see both the
  applied status AND the classification metadata.

The existing `destructiveDetected: boolean` field on
`ResultArtifact` remains for backward compatibility; it's set in
parallel with the new `migrationClassification.destructiveDetected`.

#### Diagnostic fields

The classifier surfaces lexer/parser confidence in
`ClassificationResult`:

```ts
parseWarnings: string[];   // e.g. "Unterminated /* block */ comment at line 12"
lexerComplete: boolean;    // false → any of the above; file demotes to ambiguous
```

If `lexerComplete === false`, the file is always treated as ambiguous
regardless of pattern matches.

This enforcement is independent of autopilot. Consumers calling
`cadence migrate --env=dev` directly, or invoking the dispatcher from
their own CI, get the same gate.

### 5. Autopilot skill Step 4.5 (between validate and migrate-dev)

Append a new Step 4.5 to `skills/autopilot/SKILL.md`:

> ### Step 4.5: Classify migrations (expand/contract gate)
>
> For any new `.sql` files added to the configured `deltas_dir` (or
> `data/deltas/` by default) in this PR, run:
>
> ```bash
> cadence migrate classify --file=<path>
> ```
>
> Behaviour:
>
> - **All additive (or bypassed):** proceed to Step 5 (migrate dev).
> - **Any destructive (not bypassed):** REFUSE. Surface to user:
>   `Destructive migration detected in <file>. Required pattern: expand →
>   deploy → contract in separate PRs. See docs/migrations/expand-contract.md.
>   For a sanctioned Phase 4 contract migration: add
>   `-- @autopilot: classify=contract` + `contract_after=YYYY-MM-DD`
>   + `contract_reason=<rationale>` and ensure the env has
>   `policy.allow_contract: true` with `contract_min_soak_days` met.
>   For a true emergency only: add
>   `-- @autopilot: classify=destructive_allowed_reason=incident=<ref> <rationale>`
>   (must include `incident=` or `PR=` token, ≥ 10 chars).`
> - **Any ambiguous:** require the file's leading comment block to contain
>   `-- @autopilot: classify=additive|destructive|expand|contract` to pin
>   the intent. If missing, REFUSE with the same message but pointing at
>   the ambiguous statements.

The step is implemented inside the skill (the LLM following the skill runs
the CLI verb); no additional dispatcher wiring is required.

### 6. `docs/migrations/expand-contract.md` (new)

Short doc explaining the pattern:

- Phase 1 (expand) — additive migration adds new column / table / index
  alongside old shape. Old code keeps working.
- Phase 2 (deploy + dual-write) — code starts writing both old AND new
  shapes (or reads both, prefers new).
- Phase 3 (deploy + cutover) — code reads ONLY new shape; old shape
  unused. Verify in production observability.
- Phase 4 (contract) — destructive migration drops the old shape after
  the cutover deploy has soaked for N days.

Each phase is a separate PR. Autopilot refuses to land expand + contract
in the same PR.

### 7. Bypass path (true emergencies)

```sql
-- @autopilot: classify=destructive_allowed_reason=incident=1234 hotfix for deprecated field, old shape never reached
ALTER TABLE widgets DROP COLUMN deprecated_field;
```

The reason text MUST contain either an `incident=<ref>` or `PR=<ref>`
substring (free-form after the `=`) and be at least 10 characters long
after trim. A bypass reason without a trace token is rejected — the file
is still treated as plain `destructive`.

When a valid annotation is present:
- `bypassed: true` in the result.
- `bypassReason` set to the full text after `destructive_allowed_reason=`.
- CLI exit code `0`.
- Step 4.5 proceeds, but the autopilot report (Step 9) MUST surface the
  bypass + reason in the PR description.
- Audit log records the bypass with both the reason and the trace token.

## Tests

`src/core/migrate/__tests__/classify.test.ts`:

1. **Every top-level destructive rule.** One canonical SQL fixture per
   rule from the destructive table; assert
   `classification === 'destructive'` and matching `rule`.
2. **Every top-level additive rule.** Assert `additive` + correct rule.
3. **Every top-level ambiguous rule.** Assert `ambiguous` + correct rule.
4. **Every per-clause `ALTER TABLE` rule.** One fixture per clause rule,
   classified in isolation.
5. **File reduce.** Mixed-statement files reduce to max severity.
6. **Lexer correctness — comments and strings.** Destructive keywords
   inside line comments (`-- DROP TABLE foo`), block comments
   (`/* DROP TABLE foo */`), single-quoted strings
   (`'DROP TABLE foo'`), C-style escape strings
   (`E'DROP TABLE foo\\n'`), double-quoted identifiers
   (`"DROP TABLE foo"`), and dollar-quoted bodies
   (`$$ DROP TABLE foo $$`, `$tag$ DROP TABLE foo $tag$`) do NOT
   trigger destructive classification.
7. **Lexer correctness — adversarial.** `--` inside a string
   (`'http://foo'`), `/*` inside a string, and `;` inside a string or
   parens do not corrupt the statement split.
8. **Dollar-quoted PL/pgSQL bodies.** `CREATE FUNCTION ... AS $$
   BEGIN /* -- ; */ DROP TABLE foo; END $$ LANGUAGE plpgsql` is
   `additive` (the dollar-quoted body is opaque).
9. **Annotation parsing.** Each `classify=` value parsed correctly,
   including `destructive_allowed_reason=<reason>` with quoted strings,
   and unknown values (`classify=destrcutive` typo) ignored.
10. **Bypass.** Destructive file + valid `destructive_allowed_reason`
    annotation → `bypassed: true`, file-level classification still
    `destructive`, CLI exit code `0`.
11. **Ambiguous pinning.** File reduces to `ambiguous`:
    - no annotation → CLI exit `2`
    - `classify=additive` → CLI exit `0`, `pinned=true`,
      `pinnedAs='additive'`
    - `classify=expand` → CLI exit `0`, `pinnedAs='expand'`
    - `classify=destructive` → CLI exit `1`, `pinnedAs='destructive'`
    - `classify=contract` → CLI exit `1`, `pinnedAs='contract'`
12. **`IF EXISTS` / `IF NOT EXISTS` / `ONLY`.** Optional clauses do not
    alter classification. `DROP TABLE IF EXISTS foo`,
    `ALTER TABLE ONLY foo DROP COLUMN x`,
    `ALTER TABLE IF EXISTS public.foo DROP COLUMN IF EXISTS x` all
    classify destructive on the right rule.
13. **Schema-qualified / quoted identifiers.** `DROP TABLE
    public.widgets`, `DROP TABLE "weird name"`,
    `DROP TABLE "sch ema"."table name"` all classify as
    `drop-table`.
14. **`ADD COLUMN NOT NULL` matrix.**
    - `ADD COLUMN x int` → additive
    - `ADD COLUMN x int DEFAULT 0` → additive
    - `ADD COLUMN x int NOT NULL DEFAULT 0` → additive
    - `ADD COLUMN x int NOT NULL` → ambiguous
    - `ADD COLUMN x int GENERATED ALWAYS AS (y + 1) STORED` → additive
    - `ADD COLUMN x int REFERENCES other(id)` → additive
15. **Multi-clause `ALTER TABLE`.**
    - `ALTER TABLE foo ADD COLUMN x int, DROP COLUMN y` → destructive
      (`drop-column` wins; the additive `add-column` clause does not
      hide it).
    - `ALTER TABLE foo ADD COLUMN x int, ADD COLUMN y text` → additive.
    - `ALTER TABLE foo ALTER COLUMN x SET NOT NULL,
      ADD COLUMN y int` → destructive.
    - Commas inside type modifiers (`numeric(10,2)`) do NOT split
      clauses (paren-aware split).
16. **`CREATE OR REPLACE` variants.**
    - `CREATE FUNCTION f() ...` → additive (`create-function`)
    - `CREATE OR REPLACE FUNCTION f() ...` → ambiguous
      (`create-or-replace-function`)
    - `CREATE OR REPLACE VIEW v AS ...` → ambiguous
      (`create-or-replace-view`)
17. **RLS edge cases.**
    - `CREATE POLICY p ON t FOR SELECT USING (true)` → ambiguous
      (`create-policy`) — RLS changes require human review in this
      stack.
    - `CREATE POLICY p ON t AS RESTRICTIVE FOR SELECT USING (true)` →
      ambiguous (`create-policy-restrictive`)
    - `ALTER TABLE t ENABLE ROW LEVEL SECURITY` → ambiguous
      (`enable-rls-clause`)
    - `ALTER TABLE t DISABLE ROW LEVEL SECURITY` → destructive
      (`disable-rls`) — direct security regression in an RLS-by-default
      stack.
    - `GRANT SELECT ON t TO authenticated` → ambiguous (`grant`)
    - `REVOKE SELECT ON t FROM authenticated` → ambiguous (`revoke`)
18. **CLI smoke test.** Spawn `cadence migrate classify --file=…`
    against fixtures; assert stdout JSON shape + exit code matrix.

`src/core/migrate/__tests__/dispatcher-classify.test.ts`:

19. **Dispatcher rejects destructive file.** With a `migrate.supabase@1`
    stack.md + a destructive `.sql` in the deltas dir,
    `dispatch()` returns the synthetic `error` result with
    `reasonCode === 'destructive-migration-blocked'`,
    `destructiveDetected === true`, and the skill is NEVER spawned.
20. **Dispatcher accepts additive file.** Skill is spawned, normal
    flow.
21. **Dispatcher honours per-file bypass annotation.** Skill is spawned
    (bypassed=true); audit entry includes the bypass reason.
22. **Dispatcher rejects ambiguous file with no annotation.**
    `reasonCode === 'ambiguous-migration-needs-annotation'`.

## Failure modes

- **Empty file / only comments** → `classification: 'additive'`, exit 0.
  No statements to be destructive about.
- **Unparseable file** (e.g. unbalanced quotes) → the statement splitter
  emits a best-effort split, and any "remaining tail" is classified as
  `ambiguous`. Exit code 2.
- **Annotation typo** (`classify=destrcutive`) → annotation parsing
  records the value as-is; since it doesn't match any recognized value,
  it's ignored. File reduce drives the result; if the file is
  destructive, the run blocks with the standard message. This is the
  desired safe-default.

## Acceptance (mirrors issue)

- [x] `src/core/migrate/classify.ts` ships with pattern detection
  (option A — hand-rolled, conservative).
- [x] `cadence migrate classify --file=<path>` CLI verb returns JSON
  with per-statement classification + reasoning.
- [x] Autopilot skill Step 4.5 wired in.
- [x] `docs/migrations/expand-contract.md` published.
- [x] Tests cover all destructive triggers + ambiguous cases listed in
  the rule tables above.
- [x] Bypass path documented (`-- @autopilot: classify=
  destructive_allowed_reason=<rationale>`).

## Out of scope (follow-ups)

- AST-based classification (option B). Open as a follow-up if hand-
  rolled accuracy proves insufficient in real Delegance migrations.
- Cross-file analysis (e.g. detecting that a column dropped in file N
  is read by code in file N-1). The classifier is per-file; the
  expand/contract policy is enforced at the PR level by autopilot
  Step 4.5 refusing any destructive migration alongside code changes,
  AND at the dispatcher level on every direct invocation.
- Per-clause `ALTER TABLE` machine-readable diagnostics in CI annotations
  (line/column anchors for each clause). Today the classifier reports
  the statement-level location only.

## Risk rationale (high)

This change controls whether the autopilot pipeline applies migrations
that can cause production outages on rolling deploys. False negatives
(destructive classified as additive) are direct production-incident
risk. The classifier is therefore conservative by default
(ambiguous → blocked), and the rule set is reviewed against the
Postgres DDL surface. Tagging high so it gets the full 3-pass Codex
gate.
