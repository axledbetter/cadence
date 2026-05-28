/**
 * Protocol version surface — the single source of truth for what
 * Cadence "speaks" at the protocol level (independent of the npm
 * package version).
 *
 * Spec: docs/superpowers/specs/2026-05-27-protocol-versioning-design.md
 *
 * v1.0.0 baseline (this PR): the protocol matches what the v8.5.x
 * ecosystem implicitly speaks today. No migrations ship.
 *
 * COMPONENT_META indirection (codex CRITICAL fix): the TypeScript
 * camelCase keys (`skillFrontmatter`, `phaseOutput`) do NOT match
 * the hyphenated schema filenames (`skill-frontmatter-1.0.0.json`,
 * `phase-output-1.0.0.json`). The loader looks up schemas via
 * `meta.schemaName` — never by interpolating the TS key.
 *
 * `providerRegistry` is INTENTIONALLY excluded from this baseline.
 * It's a placeholder in the spec, but no consumer is wired and no
 * schema ships. Adding it without those would tee up `schema_not_found`
 * at runtime; declare it the first PR that ships both.
 */

export const PROTOCOL_VERSION = '1.0.0' as const;

export interface ComponentMeta {
  /** The TS / API kind identifier — used as the discriminant in code. */
  readonly kind: ComponentKind;
  /** The hyphenated filename stem under `presets/schemas/`. Looked up
   *  as `${schemaName}-${version}.json`. */
  readonly schemaName: string;
  /** Current protocol version for this component (what the runtime
   *  speaks today). */
  readonly currentVersion: string;
}

export const COMPONENT_META = {
  profile: {
    kind: 'profile',
    schemaName: 'profile',
    currentVersion: '1.0.0',
  },
  skillFrontmatter: {
    kind: 'skillFrontmatter',
    schemaName: 'skill-frontmatter',
    currentVersion: '1.0.0',
  },
  state: {
    kind: 'state',
    schemaName: 'state',
    currentVersion: '1.0.0',
  },
  phaseOutput: {
    kind: 'phaseOutput',
    schemaName: 'phase-output',
    currentVersion: '1.0.0',
  },
} as const satisfies Record<string, Omit<ComponentMeta, 'kind'> & { kind: string }>;

export type ComponentKind = keyof typeof COMPONENT_META;

/** Per-component current version map. Convenience accessor that
 *  preserves the spec's flat "COMPONENT_VERSIONS" naming while the
 *  authoritative store is COMPONENT_META. */
export const COMPONENT_VERSIONS: Readonly<Record<ComponentKind, string>> = Object.freeze({
  profile: COMPONENT_META.profile.currentVersion,
  skillFrontmatter: COMPONENT_META.skillFrontmatter.currentVersion,
  state: COMPONENT_META.state.currentVersion,
  phaseOutput: COMPONENT_META.phaseOutput.currentVersion,
});

export function getComponentVersion(kind: ComponentKind): string {
  return COMPONENT_META[kind].currentVersion;
}

export function getComponentMeta(kind: ComponentKind): ComponentMeta {
  return COMPONENT_META[kind];
}

export function isKnownComponent(value: string): value is ComponentKind {
  return Object.prototype.hasOwnProperty.call(COMPONENT_META, value);
}
