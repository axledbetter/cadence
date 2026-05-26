# Plan: Issue #179 — Migration classifier (Phase 1)

Spec: `docs/superpowers/specs/2026-05-26-issue-179-migration-classifier-design.md`
Branch: `feat/issue-179-migration-classifier`
Base: `34e0bd8` (post-v8.3.0)

## Phase 1 scope (this PR)

Per the "Implementation scope split" section of the spec, this PR ships:

1. `src/core/migrate/classify.ts` — the classifier (lexer, rules, file
   reduce, annotation parsing, bypass validation).
2. `src/core/migrate/__tests__/classify.test.ts` — full test suite.
3. `src/cli/migrate.ts` — new `classify` subcommand.
4. `skills/autopilot/SKILL.md` — Step 4.5 hook between Step 4 (validate)
   and Step 5 (migrate-dev).
5. `docs/migrations/expand-contract.md` — operator-facing doc.
6. `CHANGELOG.md` — entry under `## [Unreleased]`. **No version bump.**

Dispatcher pre-flight enforcement, manifest format, `list-pending` skill
verb, and `MigrationClassification` artifact field are explicitly
DEFERRED to a Phase 2 follow-up issue (see spec). Phase 1 is correct and
useful on its own: autopilot's Step 4.5 calls the new CLI verb and gates
on its exit code, which gives autopilot users the full safety guarantee
today.

## Task graph

Tasks are sequential within Phase 1 — there's only one feature
deliverable, broken into reviewable commits.

### Task 1.1: Lexer + statement splitter

**Files:** `src/core/migrate/classify.ts` (new)

Implement the single-pass lexer described in spec section 1:
- States: `default`, `line-comment`, `block-comment` (nestable),
  `single-quote` (with `''` escape and `E'…\…'`), `double-quote`,
  `dollar-quote` (with optional tag, opaque body).
- Output: a token stream with offsets and source-line numbers
  preserved.
- `splitStatements(tokens)` — walks the stream, emits one
  `{ sql, startLine }` per top-level `;`-terminated statement.
- `extractAnnotation(sql)` — scans the leading line-comment block for
  `-- @autopilot: classify=<value>` lines. Returns `FileAnnotation`.
- `parseWarnings` accumulated for unterminated comments/strings;
  `lexerComplete: false` if any warning fires.

### Task 1.2: Rule engine + per-statement classifier

**Files:** `src/core/migrate/classify.ts` (continued)

- `normalizeStatement(sql)` — case-insensitive; strip optional
  `IF EXISTS` / `IF NOT EXISTS` / `ONLY` tokens before rule matching;
  collapse whitespace.
- `IDENT_PATTERN` — schema-qualified, optionally double-quoted name.
- `classifyAlterTable(sql)` — parse `ALTER TABLE [IF EXISTS] [ONLY]
  <IDENT>`, split remaining text on top-level commas (paren-aware,
  quote-aware via the lexer), classify each clause, reduce.
- `classifyAddColumnClause(clause)` — inspect column constraints:
  - no `NOT NULL` → additive
  - `NOT NULL` without `DEFAULT` → ambiguous
    (`add-column-not-null-no-default`)
  - `NOT NULL DEFAULT <expr>` → additive ONLY if `<expr>` matches
    `IMMUTABLE_LITERAL`, otherwise ambiguous
    (`add-column-not-null-volatile-default`)
  - `GENERATED ALWAYS AS (...) STORED` → additive (stored generated)
  - `REFERENCES <IDENT>` → additive (FK on a new column is safe)
- Top-level rules: implement the destructive / additive / ambiguous
  rule tables in spec section 2. Use small ordered grammar functions
  for `CREATE INDEX` (so `CONCURRENTLY` / `IF NOT EXISTS` ordering
  doesn't matter) and `CREATE POLICY` (so `AS RESTRICTIVE` detection
  is reliable).
- File reduce: `destructive > ambiguous > additive`.

### Task 1.3: Annotation interpretation + bypass validation

**Files:** `src/core/migrate/classify.ts` (continued)

- Parse `classify=destructive_allowed_reason=<reason>` form:
  - Split on first `=` after the prefix to get the reason text.
  - Validate: trimmed length ≥ 10, contains `incident=` OR `PR=`
    substring. Otherwise set `bypassed=false` (the file falls back to
    plain `destructive`).
- Parse `classify=contract` / `classify=additive` / etc.
  Recognise `contract_after=YYYY-MM-DD` and `contract_reason=...` as
  separate annotation lines and capture into `FileAnnotation`.
- File-result interpretation per spec section 1 step 6.

### Task 1.4: CLI verb

**Files:** `src/cli/migrate.ts` (extend)

Add `classify` subcommand to the migrate CLI. The existing
`src/cli/migrate.ts` builds an engine-wrap for the `dispatch` flow; the
new subcommand is a simpler synchronous path:

```ts
export async function runMigrateClassify(opts: {
  filePath: string;
  format?: 'json' | 'human';
}): Promise<number>;
```

- Read file (UTF-8). On read failure, emit error to stderr, exit 1.
- Call `classify(sql)`.
- Render per `--format`:
  - `json` (default): emit JSON envelope per spec section 3.
  - `human`: per-statement table with severity / rule / reason; bypass
    or pinning footer.
- Exit code matrix from spec section 3.

Wire into `src/cli/index.ts` (the bin entry) so `cadence migrate
classify --file=<path>` routes to `runMigrateClassify`.

### Task 1.5: Tests

**Files:** `src/core/migrate/__tests__/classify.test.ts` (new),
`src/cli/__tests__/migrate-classify.test.ts` (new)

Implement test cases 1–18 from spec section "Tests". CLI test (#18)
spawns the bin via `execa`-style spawn to verify stdout JSON + exit code
matrix. The pure classifier tests run in-process.

Test file follows existing patterns in `src/core/migrate/__tests__/`.
Use existing test harness (vitest? jest? check `package.json` scripts
during impl).

### Task 1.6: Autopilot Step 4.5 hook

**Files:** `skills/autopilot/SKILL.md` (edit)

Insert "### Step 4.5: Classify migrations (expand/contract gate)"
between Step 4 (validate) and Step 5 (migrate dev-only). Body per spec
section 5. Renumber subsequent steps? **No** — the existing skill uses
literal step numbers; inserting "4.5" keeps the rest stable. (Confirm
this matches the skill's referencing style during impl — if step
numbers are referenced elsewhere in the doc, adjust.)

### Task 1.7: Expand/contract doc

**Files:** `docs/migrations/expand-contract.md` (new)

Operator-facing explanation of the 4-phase pattern, per spec section 6.
Include the contract annotation example and the emergency bypass
example with the correct grammar (`incident=<ref>` or `PR=<ref>`).

### Task 1.8: CHANGELOG

**Files:** `CHANGELOG.md` (edit)

Add an entry under `## [Unreleased]` (NOT a new version section — Alex
explicitly forbade version bumps for this PR):

```md
### Added
- Migration classifier — `cadence migrate classify --file=<path>` CLI
  verb classifies SQL files as additive / destructive / ambiguous.
  Autopilot Step 4.5 gates the pipeline on destructive migrations
  without an explicit expand/contract or emergency annotation.
  See `docs/migrations/expand-contract.md` for the workflow.
  Closes #179.
```

## Test plan

- `npm test -- src/core/migrate/__tests__/classify.test.ts` — full
  classifier suite (≥30 test cases covering all 16 spec test groups).
- `npm test -- src/cli/__tests__/migrate-classify.test.ts` — CLI
  smoke test for JSON output + exit codes.
- Manual: create a fixture `data/deltas/test-destructive.sql` with
  `DROP TABLE foo;`, run `npx tsx bin/cadence.js migrate classify
  --file=…`, verify exit code 1 + JSON.
- Manual: same fixture with `-- @autopilot: classify=
  destructive_allowed_reason=incident=1234 test bypass` prepended,
  verify exit 0 + `bypassed:true`.

## Acceptance (Phase 1 subset of issue acceptance)

- [x] `src/core/migrate/classify.ts` ships with pattern detection
  (option A — hand-rolled, conservative). Phase 1.
- [x] `cadence migrate classify --file=<path>` CLI verb. Phase 1.
- [x] Autopilot skill Step 4.5 wired in. Phase 1.
- [x] `docs/migrations/expand-contract.md` published. Phase 1.
- [x] Tests cover all destructive/additive/ambiguous rules + edge cases
  in spec section "Tests" 1–18. Phase 1.
- [x] Bypass path documented + validation (`destructive_allowed_reason`
  + `incident=` / `PR=` token + ≥ 10 chars). Phase 1.
- [ ] Dispatcher pre-flight enforcement. **Phase 2 — separate issue.**
- [ ] `MigrationClassification` result-artifact field. **Phase 2.**
- [ ] `list-pending` skill verb + manifest format. **Phase 2.**
- [ ] Sanctioned `classify=contract` workflow at dispatcher level.
  **Phase 2.** (Annotation grammar ships in Phase 1; enforcement is
  Phase 2.)

## Risk reduction

- Conservative defaults: any unrecognised statement is `ambiguous`,
  which Step 4.5 refuses by default. False negatives (destructive →
  classified additive) require a missed rule AND a missed test; the
  rule table covers every triggering keyword on the issue's acceptance
  list.
- The classifier ships its full annotation grammar in Phase 1 so
  Phase 2 just wires existing data into the dispatcher — no annotation
  re-design.
- The CLI verb's stdout JSON envelope is the public contract. Phase 2
  consumers (the dispatcher) call the same `classify()` function
  directly; the CLI is for ad-hoc operator use and CI.

## Out of scope (deferred to Phase 2 or beyond)

- AST-based classification (option B). Open only if Phase 1's false-
  positive `ambiguous` rate is too high on real migrations.
- Cross-file analysis ("column dropped in file N also read by code in
  file N-1").
- Per-clause `ALTER TABLE` machine-readable line/column anchors.
