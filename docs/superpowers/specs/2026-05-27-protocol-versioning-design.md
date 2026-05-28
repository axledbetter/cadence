---
title: Cadence Protocol Versioning — first-class versioned contracts
date: 2026-05-27
risk_tier: high
status: design
---

# Cadence Protocol Versioning

## Why

The "cadence protocol" — the implicit contract between hosts, profiles, skills, phase outputs, the run-state engine, and the provider registry — is currently versioned **only** by the npm package version. The single explicit version field anywhere is `state.json.schemaVersion` (added in PR #230), and it does a binary major-version compat check with no migration path.

Consequences as the OSS ecosystem grows:
1. A profile.yaml written for cadence@8.3 silently maybe-works, maybe-fails on cadence@8.5, with no diagnostic until something blows up in a phase dispatcher.
2. A third-party SKILL.md authored against an old phaseOutput contract can be loaded by a newer cadence and produce silently-malformed state.
3. We can't ship a breaking protocol change in a minor cadence release without breaking every external profile/skill.
4. The relationship between "cadence@8.x" and "what the protocol speaks" is invisible. There's no `cadence --protocol` to print, no error message that says "this profile targets protocol vX, this cadence speaks vY."
5. No migration adapters exist — old artifacts have to be hand-edited on upgrade.

## Goal

Declare a `protocol_version` at every boundary that crosses a cadence release, version the protocol **independently from the npm package**, validate on load, and support forward-compat migrations so old artifacts work against new cadences.

## Non-goals

- Backward-compat shims for old cadences reading new artifacts (the user upgrades cadence forward, not backward — too much complexity for the value).
- Versioning of user-side SQL migrations, application code, or business logic (only the cadence protocol surfaces).
- Auto-rewriting third-party SKILL.md files in-place (too invasive — we'll print a diff and let the author choose).

## Architecture

```
package:    @delegance/cadence@8.5.0
protocol:   cadence-protocol/1.2.0
            ├── profile-schema/1.1
            ├── skill-frontmatter/1.0
            ├── state-schema/1.0   (already there)
            ├── phase-output/1.0   (lifted out of state-schema)
            └── provider-registry/1.0

A cadence at protocol 1.x supports any artifact at 1.0 ≤ x ≤ 1.x (forward-compat).
A cadence at protocol 2.x supports 1.x via migration adapters until deprecation window expires.
```

## Components

### 1. The protocol package: `src/core/protocol/`

```
src/core/protocol/
  version.ts                  // see component-version map below
  compat.ts                   // satisfies(declared, supported), migrate(...)
  changelog.md                // human-readable protocol changelog
  migrations/
    profile/
      1.0.0-to-1.1.0.ts       // adds `phases` field default
    skill-frontmatter/
      1.0.0-to-1.1.0.ts
    state/
      1.0.0-to-1.1.0.ts
    phase-output/
      implement-1.0.0-to-1.1.0.ts
```

Migrations are **per-component**, not per-global-protocol-version, because each artifact kind evolves independently (codex WARNING — global protocol bump for one component shouldn't imply skill-frontmatter bumped too).

`version.ts` exports a component-version map (codex WARNING fix):

```typescript
export const PROTOCOL_VERSION = '1.2.0' as const;
export const COMPONENT_VERSIONS = {
  profile:           '1.1.0',
  skillFrontmatter:  '1.0.0',
  state:             '1.0.0',
  phaseOutput:       '1.0.0',
  providerRegistry:  '1.0.0',
} as const;
```

When an artifact declares `protocol_version: "1.2.0"`, the loader looks up the component version for that artifact kind in `COMPONENT_VERSIONS` and validates against the matching schema. Semver is **always full triplet** internally; if an artifact declares `"1.2"`, the loader normalizes to `"1.2.0"` before any lookup (codex WARNING — semver canonicalization).

### 1a. Migration contract

Every migration is a pure function with this contract (codex NOTE):

```typescript
export interface Migration<TFrom, TTo> {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly component: ComponentKind;
  // Pre: `input` validates against fromVersion's schema.
  // Post: returned value validates against toVersion's schema.
  // Must be deterministic. Must preserve unknown extension fields unless
  // intentionally removed (and removed fields must be listed in
  // changelog with `lossy: true`).
  apply(input: TFrom): { value: TTo; warnings: string[] };
}
```

### 1b. Migration retention policy (codex WARNING)

- **Within a major**: all migrations retained indefinitely (cadence@1.5 still migrates profile@1.0 → 1.5).
- **Across majors**: bridge migration (`2.0.0-to-1.x.x`) retained for 4 minor releases of the new major, then removable with a CHANGELOG callout.

This is stricter than the original "2-minor-version window" which was too aggressive.

`compat.ts` provides:
```typescript
export function satisfies(declared: string, supported: string): 'exact' | 'forward-compat' | 'needs-migration' | 'incompatible';
export function migrate(artifact: unknown, fromVersion: string, toVersion: string, kind: ArtifactKind): unknown;
```

### 2. `protocol_version` field on every boundary artifact

- **profile.yaml**: top-level `protocol_version: "1.2"` (semver, omittable — defaults to `"1.0"`).
- **SKILL.md**: frontmatter `protocol_version: "1.2"` (defaults to `"1.0"`).
- **state.json**: rename/alias the existing `schemaVersion` to `protocol_version`; the runtime understands both during the transition.
- **phaseOutputs**: each phase output type carries `_protocolVersion` (TypeScript brand, validated at serialization).

### 3. Schema registry: `presets/schemas/`

Each protocol-versioned artifact gets a per-version schema:

```
presets/schemas/
  profile-1.0.json
  profile-1.1.json
  profile-1.2.json   # current
  skill-frontmatter-1.0.json
  state-1.0.json     # current
  phase-output-implement-1.0.json
  phase-output-review-1.0.json
  ...
```

Old schemas stay in the repo so old artifacts can validate; new ones extend (additive) or supersede (breaking, triggers migration).

### 4. Load-time handshake (codex CRITICAL — every loader returns canonical current-version DTO)

Every loader (profile loader, skill loader, state loader, run-state reader, phase-output validator) is a **three-stage pipeline**: validate against declared-version schema → migrate/normalize to current version → validate again against current-version schema → return canonical DTO. The internal engine **never** sees an old-shaped artifact.

```typescript
// Pattern, repeated per artifact kind
function loadProfile(raw: unknown): Profile_Current {
  const declared = (raw as any).protocol_version ?? '1.0.0';
  validateAgainst(`profile-${declared}.json`, raw);     // accept old shape
  const normalized = migrate(raw, declared, CURRENT_PROTOCOL, 'profile');
  validateAgainst(`profile-${CURRENT_PROTOCOL}.json`, normalized);  // assert post-migration
  return normalized as Profile_Current;
}
```

Branch table:

| Compat result | Action |
|---|---|
| `exact` (declared === current) | Validate against current schema; return as-is. |
| `older-supported` (same major, declared < current, additive change only) | Validate against declared schema; apply additive normalization (e.g. fill in default `phases: {}`); validate against current schema. |
| `older-needs-migration` (same major, declared < current, breaking-within-major) | Same pipeline but the migration step does real transformation. User-visible: "migrated profile.yaml from 1.1 → 1.2 in-memory; persist with `cadence profile upgrade --write`." |
| `newer-unsupported` (declared > current, same major) | Fail loud: "this profile targets protocol vX which this cadence (vY) doesn't speak. Upgrade cadence to ≥X or downgrade the profile." |
| `major-incompatible` (different major) | Fail loud, but check if a major-version-bridge migration exists in `migrations/<from>-to-<to>.ts` — if so, suggest the upgrade verb. |

`compat.satisfies()` returns one of these five values (codex WARNING — original three-value enum was ambiguous about `declared > supported` cases).

### 5. CLI surface

- `cadence --protocol` — print the protocol version this cadence speaks.
- `cadence protocol changelog [--since=1.0]` — print the protocol changelog (the contents of `src/core/protocol/changelog.md`, filtered).
- `cadence profile upgrade [--write]` — rewrite the profile.yaml to the current protocol version using migrations. `--write` confirms the in-place edit; default is dry-run diff.
- `cadence skill upgrade <path> [--write]` — same for SKILL.md files.

### 6. Protocol changelog discipline

`src/core/protocol/changelog.md` is a hand-curated, dated record. Every PR that changes a schema/contract amends this file. CI gate: `scripts/protocol-changelog-check.ts` fails if any of `presets/schemas/*.json`, `src/core/protocol/version.ts`, or `src/core/protocol/migrations/*.ts` changes without a matching changelog entry.

## Data flow

```
1. cadence boots.
2. PROTOCOL_VERSION = '1.2.0' baked into the binary.
3. User runs `cadence autopilot foo-spec.md`.
4. Profile loader reads profile.yaml → parses `protocol_version: "1.0"` →
   compat.satisfies('1.0', '1.2') → 'forward-compat' → loads via profile-1.0.json schema.
5. Skill loader for each skill in the pipeline → reads frontmatter →
   compat.satisfies(skill.protocol_version, '1.2') → handles per matrix above.
6. State loader / writer uses state-1.0.json schema.
7. Phase outputs are typed at the boundary; serialization includes _protocolVersion.
```

## Error handling

- Unknown `protocol_version` value (e.g. `"99.99"` from a future cadence) → `incompatible`, fail loud.
- Missing `protocol_version` field → default to `"1.0"` (current floor). This is the back-compat path for the v8.4 ecosystem.
- Migration adapter throws → fail loud, "automatic migration from 1.0 → 1.2 failed at step 1.1→1.2: <error>; manual fix required, see docs/protocol/changelog.md".
- Multiple skills with conflicting protocol versions in same pipeline → currently allowed; print summary at start of run.

## Testing

- `tests/protocol/compat.test.ts` — satisfies()/migrate() for the full version matrix.
- `tests/protocol/migrations.test.ts` — each migration adapter + chained migrations.
- `tests/protocol/loader-handshake.test.ts` — profile/skill/state loaders correctly branch on satisfies() result.
- `tests/protocol/cli.test.ts` — `--protocol`, `protocol changelog`, `profile upgrade`, `skill upgrade`.
- `tests/protocol/changelog-check.test.ts` — CI gate catches schema-without-changelog PRs.

## Rollout

1. Land this PR with `PROTOCOL_VERSION = '1.0.0'` (matches what the current ecosystem implicitly speaks). No-op behaviorally for existing users.
2. Issue subsequent PRs that bump the protocol version when they add fields (e.g. `phases` got added in PR #229 — retroactively that's `1.1.0`; the next protocol-changing PR bumps to `1.2.0` etc.).
3. After 2-3 protocol-changing releases, write an external "Protocol stability" doc for third-party skill authors.

## Backward compatibility

- Profiles/skills/states without `protocol_version` default to `"1.0"` — same as current behavior.
- Migration adapters preserve user intent (e.g. an old profile without a `phases:` block migrates to a new profile without `phases:`, not to a profile with the default phases injected).
- We commit to a **2-minor-version deprecation window** for migration adapters: if `1.0.0-to-1.1.0.ts` ships in protocol 1.1, it stays in the repo through protocol 1.3. Removal requires a CHANGELOG callout.

## Out of scope

- Backward compat (new artifacts on old cadences) — declared, won't ship.
- Plugin / extension system for third-party protocol extensions (deferred until there's demand).
- Cross-protocol artifact translation (e.g. cadence protocol → some other coding-harness format).

## Post-launch follow-ups

- Publish `docs/protocol/` as a stable URL on the dashboard (so third-party skill/profile authors can link to specific protocol versions in their READMEs).
- A `cadence protocol diff <from> <to>` verb that prints the breaking changes between two protocol versions in a human-readable format.
- Telemetry on which protocol version users' profiles declare (helps decide when a deprecation window can close).
