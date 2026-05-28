/**
 * Public surface of the cadence protocol package.
 *
 * Spec: docs/superpowers/specs/2026-05-27-protocol-versioning-design.md
 */

export {
  PROTOCOL_VERSION,
  COMPONENT_VERSIONS,
  COMPONENT_META,
  getComponentVersion,
  getComponentMeta,
  isKnownComponent,
  type ComponentKind,
  type ComponentMeta,
} from './version.ts';

export {
  satisfies,
  migrate,
  MigrationRegistry,
  DEFAULT_REGISTRY,
  type Migration,
  type SatisfiesResult,
  type SatisfiesOptions,
  type MigrateOptions,
} from './compat.ts';

export {
  createProtocolLoader,
  FilesystemSchemaRegistry,
  InMemorySchemaRegistry,
  _resetDefaultSchemaRegistry,
  type LoadResult,
  type ProtocolLoader,
  type SchemaRegistry,
  type CreateLoaderOptions,
} from './loader.ts';

export {
  ProtocolError,
  type ProtocolErrorCode,
  type ProtocolErrorOptions,
} from './errors.ts';

export { ensureMigrationsRegistered, ALL_MIGRATIONS } from './migrations/index.ts';

export {
  loadSkillFrontmatter,
  type SkillFrontmatter,
} from './skill-frontmatter.ts';

export { parse as parseSemver, normalize as normalizeSemver, compare as compareSemver, sameMajor } from './semver.ts';
