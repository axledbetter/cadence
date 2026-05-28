/**
 * Generic 3-stage protocol loader.
 *
 * Stages:
 *   1. validateAgainstDeclaredSchema  (accepts old shape)
 *   2. migrate (if older-needs-migration)
 *   3. validateAgainstCurrentSchema   (asserts canonical post-migration shape)
 *
 * Returns a canonical-current-version DTO. The internal engine never
 * sees an old-shaped artifact (codex CRITICAL — load-time handshake).
 *
 * Branch table (codex CRITICAL fix — explicit per satisfies() result):
 *   exact                  → skip migration, run stage 3 only
 *   older-supported        → skip migration, run stage 3 (additive defaults)
 *   older-needs-migration  → run stage 2, then stage 3
 *   newer-unsupported      → throw BEFORE schema lookup or migration
 *   major-incompatible     → throw BEFORE schema lookup or migration
 *
 * Schemas are looked up via `COMPONENT_META.schemaName` (hyphenated
 * filename stem), NOT the camelCase TS key. Tests inject custom
 * `schemaRegistry` + `migrationRegistry` overrides.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { findPackageRoot } from '../../cli/_pkg-root.ts';
import {
  DEFAULT_REGISTRY,
  findChainSteps,
  type MigrationRegistry,
  migrate,
  satisfies,
} from './compat.ts';
import { ProtocolError } from './errors.ts';
import { normalize } from './semver.ts';
import {
  COMPONENT_META,
  type ComponentKind,
  type ComponentMeta,
  isKnownComponent,
} from './version.ts';

/** What the loader returns. */
export interface LoadResult<T> {
  /** Canonical current-version DTO (structurally validated against the
   *  current schema). */
  value: T;
  /** Non-fatal warnings (chained migration messages, etc.). */
  warnings: string[];
  declaredVersion: string;
  currentVersion: string;
  /** True iff a migration step actually ran (false for exact /
   *  older-supported). */
  migrated: boolean;
}

/** Pluggable schema lookup. Production binds to filesystem; tests
 *  inject in-memory schemas. */
export interface SchemaRegistry {
  /** Return the parsed JSON schema for `${schemaName}-${version}.json`
   *  or undefined if not registered. */
  resolve(schemaName: string, version: string): object | undefined;
}

/** Filesystem-backed schema registry — looks up
 *  `<packageRoot>/presets/schemas/${schemaName}-${version}.json`. */
export class FilesystemSchemaRegistry implements SchemaRegistry {
  private readonly cache = new Map<string, object>();

  constructor(private readonly packageRoot: string) {}

  resolve(schemaName: string, version: string): object | undefined {
    const key = `${schemaName}-${version}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const filename = `${schemaName}-${version}.json`;
    const fullPath = path.join(this.packageRoot, 'presets', 'schemas', filename);
    if (!fs.existsSync(fullPath)) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (err) {
      throw new ProtocolError(
        `Failed to parse schema ${filename}: ${err instanceof Error ? err.message : String(err)}`,
        {
          code: 'schema_not_found',
          details: { schemaName, version, path: fullPath },
          cause: err,
        },
      );
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new ProtocolError(
        `Schema ${filename} did not parse to an object`,
        { code: 'schema_not_found', details: { schemaName, version, path: fullPath } },
      );
    }
    this.cache.set(key, parsed as object);
    return parsed as object;
  }
}

/** In-memory schema registry — tests register schemas before invoking
 *  the loader. */
export class InMemorySchemaRegistry implements SchemaRegistry {
  private readonly map = new Map<string, object>();

  register(schemaName: string, version: string, schema: object): void {
    this.map.set(`${schemaName}-${normalize(version)}`, schema);
  }

  resolve(schemaName: string, version: string): object | undefined {
    return this.map.get(`${schemaName}-${normalize(version)}`);
  }
}

let _defaultRegistry: FilesystemSchemaRegistry | null = null;

function getDefaultSchemaRegistry(): FilesystemSchemaRegistry {
  if (_defaultRegistry !== null) return _defaultRegistry;
  const root = findPackageRoot(import.meta.url);
  if (!root) {
    throw new ProtocolError(
      'Could not locate cadence package root for schema resolution',
      { code: 'schema_not_found' },
    );
  }
  _defaultRegistry = new FilesystemSchemaRegistry(root);
  return _defaultRegistry;
}

/** Test-only — reset the default filesystem registry cache (used by
 *  tests that swap synthetic package roots). */
export function _resetDefaultSchemaRegistry(): void {
  _defaultRegistry = null;
  _validatorCache.clear();
}

// --- Ajv compile cache --------------------------------------------------
// Keyed by `${schemaName}-${version}` so two distinct versions of the
// same component compile separately. The Ajv instance is shared across
// keys (Ajv compilation is the hot path; the validator itself is cheap).
// useDefaults=true so optional `protocol_version` with a default value
// fills in on input that omits it (codex WARNING — explicit Ajv opts).
// Structured-clone of input happens at the loader boundary, NOT here,
// so this cache returns mutating validators safely.
const _validatorCache = new Map<string, ValidateFunction>();
let _ajv: Ajv | null = null;

function getAjv(): Ajv {
  if (_ajv !== null) return _ajv;
  _ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
  addFormats(_ajv);
  return _ajv;
}

function compileSchema(
  schemaName: string,
  version: string,
  schema: object,
): ValidateFunction {
  const key = `${schemaName}-${version}`;
  const cached = _validatorCache.get(key);
  if (cached !== undefined) return cached;
  const compiled = getAjv().compile(schema);
  _validatorCache.set(key, compiled);
  return compiled;
}

/**
 * Structured clone of arbitrary JSON-ish input. Used so Ajv's
 * `useDefaults: true` doesn't mutate the caller's object — important
 * for `profile upgrade --dry-run` diffs and any caller that keeps a
 * reference to the original.
 */
function cloneInput<T>(input: T): T {
  // structuredClone is Node 17+; we target Node 22 so always available.
  return structuredClone(input);
}

export interface CreateLoaderOptions {
  /** ComponentKind — must be present in COMPONENT_META unless
   *  overridden by `meta`. Tests pass their own meta for synthetic
   *  components. */
  component: ComponentKind | string;
  /** Override the metadata block (tests / synthetic components). */
  meta?: ComponentMeta;
  /** Schema lookup. Default: filesystem-backed registry pointing at the
   *  package root. */
  schemaRegistry?: SchemaRegistry;
  /** Migration adapters. Default: DEFAULT_REGISTRY (the registry
   *  populated by `migrations/index.ts`). */
  migrationRegistry?: MigrationRegistry;
  /** Override the protocol version this loader treats as "current".
   *  Default: meta.currentVersion. */
  currentVersion?: string;
}

export interface ProtocolLoader<T = unknown> {
  load(raw: unknown): LoadResult<T>;
  readonly component: string;
  readonly currentVersion: string;
}

/**
 * Factory — creates a loader pinned to a single component.
 *
 * Lifecycle of `load(raw)`:
 *  1. Extract `declared = raw.protocol_version ?? '1.0.0'`, normalize.
 *  2. Branch on `satisfies(declared, current, { registry, component })`:
 *     - newer-unsupported / major-incompatible → throw immediately.
 *  3. Stage 1: validate cloned input against `${schemaName}-${declared}.json`.
 *  4. Stage 2 (if older-needs-migration): migrate to current.
 *  5. Stage 3: validate against `${schemaName}-${current}.json`.
 *  6. Return canonical DTO + warnings.
 */
export function createProtocolLoader<T = unknown>(
  opts: CreateLoaderOptions,
): ProtocolLoader<T> {
  // Resolve metadata. For known components, fall back to COMPONENT_META;
  // tests can override either by passing `meta` or by passing a string
  // component identifier with `meta` explicitly.
  let meta: ComponentMeta;
  if (opts.meta !== undefined) {
    meta = opts.meta;
  } else if (typeof opts.component === 'string' && isKnownComponent(opts.component)) {
    meta = COMPONENT_META[opts.component];
  } else {
    throw new ProtocolError(
      `Unknown protocol component: ${opts.component}`,
      { code: 'unknown_component', details: { component: opts.component } },
    );
  }
  const currentVersion = normalize(opts.currentVersion ?? meta.currentVersion);
  const migrationRegistry = opts.migrationRegistry ?? DEFAULT_REGISTRY;
  const schemaRegistry = opts.schemaRegistry ?? getDefaultSchemaRegistry();

  function resolveValidator(version: string): ValidateFunction {
    const schema = schemaRegistry.resolve(meta.schemaName, version);
    if (!schema) {
      throw new ProtocolError(
        `Schema not registered: ${meta.schemaName}-${version}.json`,
        {
          code: 'schema_not_found',
          details: { component: meta.kind, schemaName: meta.schemaName, version },
        },
      );
    }
    return compileSchema(meta.schemaName, version, schema);
  }

  function load(raw: unknown): LoadResult<T> {
    if (raw === null || typeof raw !== 'object') {
      throw new ProtocolError(
        `Protocol loader for ${meta.kind} requires an object input`,
        { code: 'validation_failed', details: { component: meta.kind } },
      );
    }
    const cloned = cloneInput(raw) as Record<string, unknown>;
    const declaredRaw =
      typeof cloned.protocol_version === 'string' ? cloned.protocol_version : '1.0.0';
    const declared = normalize(declaredRaw);

    const verdict = satisfies(declared, currentVersion, {
      registry: migrationRegistry,
      component: meta.kind as ComponentKind,
    });

    if (verdict === 'newer-unsupported') {
      throw new ProtocolError(
        `${meta.kind}: artifact targets protocol ${declared} but this cadence speaks ${currentVersion}. ` +
          `Upgrade cadence to >= ${declared} or downgrade the artifact.`,
        {
          code: 'newer_unsupported',
          details: { component: meta.kind, declared, currentVersion },
          hint: `Run \`cadence --protocol\` to see what this binary speaks.`,
        },
      );
    }
    if (verdict === 'major-incompatible') {
      throw new ProtocolError(
        `${meta.kind}: artifact targets protocol ${declared}, incompatible with this cadence's protocol ${currentVersion} (different major).`,
        {
          code: 'major_incompatible',
          details: { component: meta.kind, declared, currentVersion },
          hint: `See \`cadence protocol changelog\` for the breaking-change list.`,
        },
      );
    }

    // Stage 1 — validate cloned input against declared-version schema.
    const declaredValidator = resolveValidator(declared);
    if (!declaredValidator(cloned)) {
      const errors = (declaredValidator.errors ?? []).slice(0, 5).map(formatAjvError);
      throw new ProtocolError(
        `${meta.kind}: declared-version schema ${meta.schemaName}-${declared}.json validation failed:\n  ${errors.join('\n  ')}`,
        {
          code: 'validation_failed',
          details: { component: meta.kind, declared, errors: declaredValidator.errors ?? [] },
        },
      );
    }

    // Stage 2 — migrate when older-needs-migration. exact / older-supported skip.
    // Codex WARNING fix — per-step validation: each intermediate
    // migration's output is validated against the NEXT version's schema
    // before being fed into the next adapter. This catches a faulty
    // 1.0.0->1.1.0 migration immediately at the 1.1.0 schema boundary
    // rather than letting bad data cascade into 1.1.0->1.2.0 where the
    // error message becomes misleading.
    let migrated = false;
    const warnings: string[] = [];
    let working: unknown = cloned;
    if (verdict === 'older-needs-migration') {
      const chain = migrationRegistry.getEdges(meta.kind as ComponentKind);
      const path = findChainSteps(chain, declared, currentVersion);
      for (let i = 0; i < path.length - 1; i += 1) {
        const stepFrom = path[i]!;
        const stepTo = path[i + 1]!;
        const stepResult = migrate(working, stepFrom, stepTo, meta.kind as ComponentKind, {
          registry: migrationRegistry,
        });
        // Validate intermediate output against the step-to schema BEFORE
        // continuing to the next migration (unless step-to is the
        // current version — that's stage 3 below).
        if (stepTo !== currentVersion) {
          const intermediateValidator = resolveValidator(stepTo);
          if (!intermediateValidator(stepResult.value)) {
            const errors = (intermediateValidator.errors ?? []).slice(0, 5).map(formatAjvError);
            throw new ProtocolError(
              `${meta.kind}: intermediate migration output (${stepFrom}->${stepTo}) failed schema validation:\n  ${errors.join('\n  ')}`,
              {
                code: 'migration_failed',
                details: { component: meta.kind, stepFrom, stepTo, errors: intermediateValidator.errors ?? [] },
              },
            );
          }
        }
        working = stepResult.value;
        for (const w of stepResult.warnings) warnings.push(w);
      }
      migrated = true;
    }

    // Stage 3 — validate canonical against current-version schema.
    const currentValidator = resolveValidator(currentVersion);
    if (!currentValidator(working)) {
      const errors = (currentValidator.errors ?? []).slice(0, 5).map(formatAjvError);
      throw new ProtocolError(
        `${meta.kind}: post-migration validation against ${meta.schemaName}-${currentVersion}.json failed:\n  ${errors.join('\n  ')}`,
        {
          code: 'validation_failed',
          details: {
            component: meta.kind,
            declared,
            currentVersion,
            errors: currentValidator.errors ?? [],
          },
        },
      );
    }

    // Ensure the canonical DTO carries the current protocol_version. Ajv
    // useDefaults fills the default when the field is absent, but if the
    // declared was e.g. '1.0' (older-supported, additive), we want the
    // returned DTO to reflect the canonical full triplet of CURRENT.
    if (typeof (working as Record<string, unknown>).protocol_version === 'string') {
      const existing = normalize((working as Record<string, unknown>).protocol_version as string);
      if (existing !== currentVersion && verdict === 'older-supported') {
        // Keep the declared version on additive-compatible loads — the
        // caller may want to know "this artifact targeted 1.0.0 even
        // though we speak 1.1.0 now". Don't silently overwrite.
      }
    }

    return {
      value: working as T,
      warnings,
      declaredVersion: declared,
      currentVersion,
      migrated,
    };
  }

  return {
    load,
    component: meta.kind,
    currentVersion,
  };
}

function formatAjvError(e: {
  instancePath?: string;
  message?: string;
  keyword?: string;
  params?: Record<string, unknown>;
}): string {
  const loc = e.instancePath
    ? e.instancePath.replace(/^\//, '').replace(/\//g, '.')
    : '<root>';
  if (e.keyword === 'additionalProperties' && e.params && typeof e.params.additionalProperty === 'string') {
    return `${loc}: unexpected key "${e.params.additionalProperty}"`;
  }
  return `${loc}: ${e.message ?? 'invalid'}`;
}
