# Cadence Protocol Changelog

This file is the **hand-curated, dated record of every change to the cadence
protocol**. The protocol is versioned independently of the `@delegance/cadence`
npm package — see `docs/superpowers/specs/2026-05-27-protocol-versioning-design.md`.

Every PR that modifies any of:

- `presets/schemas/*.json`
- `src/core/protocol/version.ts`
- `src/core/protocol/migrations/**/*.ts` (non-boilerplate)

MUST add a matching entry below. CI gate: `scripts/protocol-changelog-check.ts`
fails the build otherwise.

## How to read this file

- Each version section corresponds to one `PROTOCOL_VERSION` value.
- Per-component bumps are listed under the protocol version that shipped them.
- Migrations are noted with `migration: <component> <from>-to-<to>` when an
  adapter is required.
- Lossy field removals are explicitly flagged `lossy: true`.

---

## 1.0.0 — 2026-05-27

Initial protocol baseline. Codifies what the v8.5.x ecosystem implicitly
spoke. No migrations ship (the baseline is the starting point).

Component versions at 1.0.0:

- `profile` 1.0.0 — `presets/schemas/profile-1.0.0.json` (snapshot of the
  current `profile.schema.json`, with explicit optional `protocol_version`
  field). Covers single-developer (solo), small-team, enterprise,
  oss-maintainer, learning profiles.
- `skill-frontmatter` 1.0.0 — minimal contract: `name`, `description`,
  optional `protocol_version`. `additionalProperties: true` is intentional —
  skills carry arbitrary extension fields (allowed-tools, etc.) that the
  protocol layer doesn't enumerate.
- `state` 1.0.0 — the v6 RunState envelope shape. The internal
  `schema_version` integer (v6/v7 wire format, owned by
  `RUN_STATE_SCHEMA_VERSION` in `src/core/run-state/types.ts`) is a SEPARATE
  concern from `protocol_version`; both fields are required on every
  state.json snapshot going forward.
- `phase-output` 1.0.0 — generic envelope: `phase`, `status`, optional
  `artifacts[]`, free-form `meta`. v1.0.0 is intentionally NOT per-phase
  (codex WARNING — the loader's `${schemaName}-${version}.json` lookup
  doesn't carry a phase axis). A future protocol bump may split into
  phase-specific variants (e.g. `phase-output-implement-2.0.0.json`) via
  the `COMPONENT_META.schemaName` indirection.

Excluded from this baseline:

- `provider-registry` — declared in the spec but no consumer is wired and
  no schema ships. Adding it without those would tee up `schema_not_found`
  at runtime. Will be added in the first PR that ships both.

CLI surface introduced:

- `cadence --protocol` — prints `PROTOCOL_VERSION` and the
  `COMPONENT_VERSIONS` map.
- `cadence protocol changelog [--since=X.Y.Z]` — prints this changelog,
  filtered.
- `cadence profile upgrade <path> [--write]` — dry-run by default, rewrites
  the profile to the canonical current-protocol shape with `--write`.

Loader integration:

- Profile loader (`src/core/profile/resolver.ts`) runs every loaded
  profile.yaml through the protocol loader BEFORE the legacy Ajv strict
  check. v1.0.0 baseline is a functional no-op (declared=current=1.0.0).
- State writer (`src/core/run-state/state.ts`) stamps every new state.json
  with `protocol_version: "1.0.0"`. Old state.json files without the field
  default to "1.0.0" on read.
- SKILL.md frontmatter loader is exposed via `loadSkillFrontmatter()` but
  not yet wired into every read site — that's a follow-up PR.

CI gate: `scripts/protocol-changelog-check.ts` is now enforced.

---

<!-- New entries go here. One `## X.Y.Z — YYYY-MM-DD` heading per protocol
     version bump. -->
