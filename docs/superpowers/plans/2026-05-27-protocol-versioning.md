---
title: Cadence Protocol Versioning — implementation plan
date: 2026-05-27
spec: docs/superpowers/specs/2026-05-27-protocol-versioning-design.md
risk_tier: high
---

# Protocol Versioning — Implementation Plan

This plan implements the `protocol_version` baseline (v1.0.0) per the spec.
Scope is the framework — current ecosystem is implicitly 1.0.0, so no migrations
ship yet, but the per-component migration directories are wired so the FIRST
breaking change ships an adapter cleanly.

## Sequencing

Order matters: data layer → validation layer → loader pipeline → integration
into existing loaders → CLI surface → CI gate → tests. Each block is one
commit so reviewers can bisect.

### Block 1 — Protocol data layer

New files in `src/core/protocol/`:

1. `version.ts`
   - `export const PROTOCOL_VERSION = '1.0.0' as const;`
   - `export const COMPONENT_VERSIONS = { profile, skillFrontmatter, state, phaseOutput, providerRegistry } as const` all at `'1.0.0'`.
   - `ComponentKind` type union derived from the keys.
   - Helper `getComponentVersion(kind: ComponentKind): string`.

2. `semver.ts`
   - `normalize(v: string): string` — accepts `'1'`, `'1.2'`, `'1.2.0'`, returns full triplet. Rejects malformed input with `ProtocolError`.
   - `compare(a, b)` — strict semver numeric compare, returns `-1 | 0 | 1`.
   - `sameMajor(a, b)` — boolean.
   - Pure function module, no I/O.

3. `errors.ts`
   - `ProtocolError extends Error` with `code: ProtocolErrorCode` discriminant. Codes: `invalid_version`, `unknown_component`, `schema_not_found`, `validation_failed`, `migration_failed`, `migration_not_found`, `newer_unsupported`, `major_incompatible`, `changelog_drift`.

### Block 2 — Compat + migration contract

4. `compat.ts`
   - `satisfies(declared: string, supported: string): SatisfiesResult` — 5-state enum: `'exact' | 'older-supported' | 'older-needs-migration' | 'newer-unsupported' | 'major-incompatible'`. Inputs normalized first.
   - `Migration<TFrom, TTo>` interface per spec (apply returns `{value, warnings}`).
   - `MigrationRegistry` — per-component map from `${from}->${to}` → Migration.
   - `findMigrationChain(component, from, to)` — BFS over registered migrations; returns ordered list or throws `migration_not_found`.
   - `migrate(input, fromVersion, toVersion, component)` — pipes input through the chain; aggregates warnings. Pure, deterministic.

5. `migrations/index.ts`
   - Hand-curated registry export. Empty for each component at 1.0.0 baseline.
   - Folder layout per spec:
     ```
     migrations/
       profile/
       skill-frontmatter/
       state/
       phase-output/
       provider-registry/
       index.ts        // assembles MigrationRegistry from per-component imports
     ```
   - Each component dir has a `.gitkeep` and an `index.ts` exporting `[]`.

### Block 3 — Schema registry

6. `presets/schemas/profile-1.0.0.json` — duplicate of current
   `profile.schema.json`, additive: top-level `protocol_version` (optional,
   default `'1.0.0'`, semver-pattern). The existing `profile.schema.json`
   stays as the legacy/un-versioned alias so older callers still work.

7. `presets/schemas/skill-frontmatter-1.0.0.json` — minimal initial schema:
   `name` (string, required), `description` (string, required),
   `protocol_version` (string, optional, default `'1.0.0'`),
   `additionalProperties: true` (skill frontmatter is intentionally open).

8. `presets/schemas/state-1.0.0.json` — encode the v6 RunState shape:
   `schema_version`, `protocol_version` (optional, default `'1.0.0'`),
   `runId`, `status`, `phases[]`, `startedAt`, `currentPhaseIdx`,
   `totalCostUSD`, `lastEventSeq`, `writerId`, `cwd`. `additionalProperties: true`
   for forward-compat.

9. `presets/schemas/phase-output-implement-1.0.0.json` — generic phase-output
   envelope: `protocol_version` (optional, default `'1.0.0'`), `phase` (string),
   `status` (`succeeded`|`failed`|`skipped`), `artifacts[]` array, free-form
   `meta` object. `additionalProperties: true`.

### Block 4 — Generic 3-stage loader

10. `loader.ts`
    - `createProtocolLoader<TIn, TOut>({ component, normalizers })` factory:
      - Stage 1: `validateAgainstDeclaredSchema` — looks up
        `presets/schemas/${component}-${declaredVersion}.json` and runs Ajv.
      - Stage 2: `migrate(raw, declared, current, component)` from compat.ts.
      - Stage 3: `validateAgainstCurrentSchema` — looks up
        `presets/schemas/${component}-${CURRENT}.json` and runs Ajv.
    - Returns `{ value: TOut, warnings: string[], declaredVersion, currentVersion, migrated: boolean }`.
    - Ajv compile cache keyed by `${component}-${version}`.
    - Loader factory throws `ProtocolError(newer_unsupported)` /
      `ProtocolError(major_incompatible)` per the satisfies() branch table.

### Block 5 — Changelog

11. `changelog.md` (under `src/core/protocol/`):
    - Header explaining purpose.
    - Entry `## 1.0.0 — 2026-05-27` describing the baseline contract for each
      component (profile, skill-frontmatter, state, phase-output,
      provider-registry).
    - Forward-looking section explaining how future entries are structured
      (one heading per protocol version with per-component bumps listed).

### Block 6 — Integrate into existing loaders

12. Profile loader integration — `src/core/profile/resolver.ts`:
    - After `parsed = yaml.load(raw)` and BEFORE the existing Ajv validate
      step, call the protocol loader:
      ```
      const declared = (parsed as any).protocol_version ?? '1.0.0';
      const result = profileProtocolLoader.load(parsed);
      parsed = result.value;
      ```
    - Then continue with the existing schema validation against
      `profile.schema.json` (which becomes the strict current-shape check).
    - Add `protocol_version` to `ProfileConfig` type as optional (defaults
      filled by loader).

13. State loader integration — `src/core/run-state/state.ts`:
    - In `readStateSnapshot()`, after `JSON.parse(raw)` returns, run through
      `stateProtocolLoader.load(parsed)`. Existing `schema_version` field
      stays for the internal v6 engine (separate concern); `protocol_version`
      is added as new optional top-level field.
    - Writer side: `writeStateSnapshot` adds `protocol_version: PROTOCOL_VERSION`
      to every snapshot it writes (so new state files declare it explicitly).

14. Skill frontmatter loader — Cadence already parses SKILL.md frontmatter in
    a couple of spots; grep for `yaml.load.*frontmatter` and find the
    canonical reader. For v1.0.0 baseline, EXPOSE the loader factory + a
    helper `loadSkillFrontmatter(raw)`; defer wiring into every read site to
    a follow-up PR (noted in changelog). The framework is in.

### Block 7 — CLI surface

15. New file `src/cli/protocol.ts`:
    - `runProtocolPrint()` — prints `PROTOCOL_VERSION` + component-version map.
      Backs the `cadence --protocol` flag.
    - `runProtocolChangelog([--since=X.Y.Z])` — reads
      `src/core/protocol/changelog.md`, filters by since, prints.
    - `runProtocolCommand(args)` — dispatcher with sub-verbs:
      `changelog`, `--help`.

16. New file `src/cli/profile-upgrade.ts`:
    - `runProfileUpgrade({ path, write })` — reads profile.yaml, runs the
      protocol loader to get the canonical current-version DTO, computes
      diff vs original. With `--write` does `yaml.dump(canonical)` back
      to file (best-effort comment preservation TODO — initial impl
      strips comments with a clear warning; spec note about full
      comment-preserving rewrite as follow-up).
    - Default behavior: dry-run, prints unified diff.

17. Wire into `src/cli/index.ts`:
    - Detect `--protocol` global flag pre-subcommand-dispatch (similar to
      `--profile`); when present and no subcommand follows, print and exit 0.
    - Register `protocol` and `profile upgrade` subcommands in
      `SUBCOMMANDS` array and the switch.
    - Update help text in `help-text.ts`.

### Block 8 — CI gate

18. `scripts/protocol-changelog-check.ts`:
    - Detects if the current commit (vs `git merge-base origin/master HEAD`)
      modifies any of:
      - `presets/schemas/*.json`
      - `src/core/protocol/version.ts`
      - `src/core/protocol/migrations/**/*.ts` (excluding `.gitkeep`,
        `index.ts` boilerplate)
    - If yes, requires `src/core/protocol/changelog.md` to also be modified
      in the same diff range, otherwise exits 1 with a clear message.
    - When run on a worktree (no merge-base available because of new branch):
      fallback to comparing tip against `git rev-parse master`.

### Block 9 — Tests

All under `tests/protocol/`:

19. `tests/protocol/semver.test.ts` — normalize edge cases, compare edge cases.

20. `tests/protocol/compat.test.ts` — `satisfies()` exhaustive matrix for all
    5 states across the same-major / different-major axes; includes "1.2 vs
    1.2.0" normalization-equivalence assertions.

21. `tests/protocol/migrations.test.ts` — migration contract tests using
    SYNTHETIC migrations registered in the test only (the v1.0.0 baseline
    ships zero real migrations): assert
    - apply is invoked
    - warnings aggregated across chain
    - chain ordering verified (1.0.0->1.1.0->1.2.0 picks both steps)
    - unknown-target throws `migration_not_found`
    - input-validates-against-from-schema enforced by harness

22. `tests/protocol/loader-handshake.test.ts` — 3-stage pipeline tests using
    a synthetic component:
    - exact-version load (no migration)
    - older-supported (additive normalization succeeds)
    - older-needs-migration (synthetic adapter applied; post-validate passes)
    - newer-unsupported (loader throws `ProtocolError(newer_unsupported)`)
    - major-incompatible (throws `ProtocolError(major_incompatible)`)

23. `tests/protocol/cli.test.ts` — spawn-or-direct-call tests for
    `--protocol`, `protocol changelog`, `profile upgrade --dry-run`. Use a
    fixture profile in a tmp dir.

24. `tests/protocol/changelog-check.test.ts` — invoke the CI gate against
    synthetic git states (fixture repo created in beforeEach via a
    git init in tmp).

## Validation

After each block runs `npm run build` to keep TS clean. Final pass:
- `npm run build`
- `npm test -- tests/protocol`
- `npm test` full suite (verify no existing test broke)

## Risk + rollback

This is additive at v1.0.0 baseline. The protocol loader on existing files
is a no-op functionally (declared=1.0.0, current=1.0.0 → 'exact' → straight
passthrough). The single behavior change: state.json now carries a new
`protocol_version` field. Old v7 binaries reading newer state.json files
ignore unknown fields (already permissive), so the rollback story is
clean — delete the `protocol_version` field and the new code paths become
no-op.

## Out of scope (explicitly)

- Migrations for old artifact shapes (declared 1.0.0 baseline matches
  current; no migration to write).
- Full SKILL.md frontmatter integration (helper exposed; wiring deferred).
- YAML comment preservation in `profile upgrade --write` (clear warning
  emitted on first version; full impl is follow-up).
- Provider registry schema (declared in COMPONENT_VERSIONS, schema file
  shipped, but no consumer yet — placeholder for next protocol bump).
