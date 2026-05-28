/**
 * Compat + migration contract for the cadence protocol.
 *
 * `satisfies()` returns a 5-state enum (codex CRITICAL — original
 * 3-state was ambiguous about "declared > supported" cases and didn't
 * distinguish additive-compatible from breaking-within-major):
 *
 *   exact                   — declared === current; no work needed.
 *   older-supported         — declared < current, same major, no migration
 *                             registered for the gap. Additive-compatible —
 *                             load via declared schema, normalize via Ajv
 *                             defaults to current shape.
 *   older-needs-migration   — declared < current, same major, a migration
 *                             edge exists for the gap. Run the migration.
 *   newer-unsupported       — declared > current, same major. Fail loud;
 *                             user must upgrade cadence or downgrade the
 *                             artifact.
 *   major-incompatible      — different major. Fail loud unless a
 *                             cross-major bridge migration is registered.
 *
 * The classification policy (codex WARNING fix): the migration registry
 * IS the source of truth for "does this gap need an adapter?" — adding
 * a migration in a future PR automatically flips classification from
 * `older-supported` to `older-needs-migration` without any caller code
 * change.
 *
 * `migrate()` is pure, deterministic, and a no-op when from === to
 * (codex CRITICAL fix — defensive guard so loaders that always call
 * migrate() can't accidentally throw migration_not_found on exact loads).
 */

import { ProtocolError } from './errors.ts';
import { compare, normalize, sameMajor } from './semver.ts';
import type { ComponentKind } from './version.ts';

export type SatisfiesResult =
  | 'exact'
  | 'older-supported'
  | 'older-needs-migration'
  | 'newer-unsupported'
  | 'major-incompatible';

/**
 * Migration contract — every adapter is a pure function with strict
 * pre/post conditions enforced by the loader pipeline.
 *
 *  - `apply()` MUST be deterministic. Given identical input, returns
 *    identical output + warnings.
 *  - Input MUST already validate against `fromVersion`'s schema. The
 *    loader's stage-1 validate enforces this.
 *  - Output MUST validate against `toVersion`'s schema. The loader's
 *    stage-3 validate enforces this.
 *  - Unknown extension fields MUST be preserved unless intentionally
 *    removed; lossy field removal MUST be listed in the changelog with
 *    `lossy: true`.
 *  - `warnings[]` carries non-fatal user-visible notes (e.g. "field X
 *    was renamed to Y; old value retained for one minor release").
 */
export interface Migration<TFrom = unknown, TTo = unknown> {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly component: ComponentKind;
  apply(input: TFrom): { value: TTo; warnings: string[] };
}

/**
 * Per-component registry of migrations keyed by `${from}->${to}` (both
 * normalized full triplets). Map is intentionally flat — the chain
 * builder reconstructs ordering via BFS.
 */
export class MigrationRegistry {
  private readonly byComponent = new Map<ComponentKind, Map<string, Migration>>();

  register(migration: Migration): void {
    const from = normalize(migration.fromVersion);
    const to = normalize(migration.toVersion);
    const key = `${from}->${to}`;
    if (!this.byComponent.has(migration.component)) {
      this.byComponent.set(migration.component, new Map());
    }
    const componentMap = this.byComponent.get(migration.component)!;
    if (componentMap.has(key)) {
      throw new ProtocolError(
        `Duplicate migration registration for ${migration.component} ${key}`,
        { code: 'migration_failed', details: { component: migration.component, from, to } },
      );
    }
    componentMap.set(key, migration);
  }

  /** Returns all registered edges for a component (used by satisfies()
   *  to decide older-supported vs older-needs-migration). */
  getEdges(component: ComponentKind): ReadonlyArray<{ from: string; to: string }> {
    const componentMap = this.byComponent.get(component);
    if (!componentMap) return [];
    return Array.from(componentMap.values()).map(m => ({
      from: normalize(m.fromVersion),
      to: normalize(m.toVersion),
    }));
  }

  /** Returns the migration adapter for a single edge, or undefined. */
  getEdge(component: ComponentKind, from: string, to: string): Migration | undefined {
    return this.byComponent.get(component)?.get(`${normalize(from)}->${normalize(to)}`);
  }
}

/** Shared registry singleton. Tests can swap in their own by passing
 *  `registry` overrides to `satisfies()` / `migrate()`. */
export const DEFAULT_REGISTRY = new MigrationRegistry();

export interface SatisfiesOptions {
  registry?: MigrationRegistry;
  component?: ComponentKind;
}

/**
 * Compatibility classifier — see file header for the 5-state semantics.
 *
 * The `registry` + `component` opts are how `older-supported` vs
 * `older-needs-migration` is decided: if ANY migration edge for the
 * component spans the [declared, supported] gap, classification is
 * `older-needs-migration`. Otherwise it's `older-supported`.
 *
 * Without registry/component (called from generic compat code without
 * a specific component context), older-same-major defaults to
 * `older-supported` — callers that need migration-aware classification
 * must supply both options.
 */
export function satisfies(
  declared: string,
  supported: string,
  opts: SatisfiesOptions = {},
): SatisfiesResult {
  const d = normalize(declared);
  const s = normalize(supported);
  if (d === s) return 'exact';
  if (!sameMajor(d, s)) return 'major-incompatible';
  const cmp = compare(d, s);
  if (cmp > 0) return 'newer-unsupported';
  // cmp < 0 — declared is older than supported, same major.
  if (opts.registry && opts.component) {
    const edges = opts.registry.getEdges(opts.component);
    if (hasPathInRange(edges, d, s)) {
      return 'older-needs-migration';
    }
  }
  return 'older-supported';
}

/** Does any chain of registered edges go from `from` to `to`? */
function hasPathInRange(
  edges: ReadonlyArray<{ from: string; to: string }>,
  from: string,
  to: string,
): boolean {
  if (edges.length === 0) return false;
  try {
    findChain(edges, from, to);
    return true;
  } catch {
    return false;
  }
}

/**
 * BFS over registered edges. Returns the ordered list of versions in
 * the chain (inclusive of from and to). Throws if no chain exists.
 */
function findChain(
  edges: ReadonlyArray<{ from: string; to: string }>,
  from: string,
  to: string,
): string[] {
  if (from === to) return [from];
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const queue: Array<{ node: string; path: string[] }> = [{ node: from, path: [from] }];
  const seen = new Set<string>([from]);
  while (queue.length > 0) {
    const { node, path } = queue.shift()!;
    const nexts = adj.get(node) ?? [];
    for (const n of nexts) {
      if (n === to) return [...path, n];
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push({ node: n, path: [...path, n] });
    }
  }
  throw new ProtocolError(
    `No migration chain from ${from} to ${to}`,
    { code: 'migration_not_found', details: { from, to } },
  );
}

export interface MigrateOptions {
  registry?: MigrationRegistry;
}

/**
 * Apply the chained migrations from `from` to `to` for `component`.
 * Pure and deterministic. No-op when from === to (codex CRITICAL fix).
 */
export function migrate(
  input: unknown,
  fromVersion: string,
  toVersion: string,
  component: ComponentKind,
  opts: MigrateOptions = {},
): { value: unknown; warnings: string[] } {
  const from = normalize(fromVersion);
  const to = normalize(toVersion);
  if (from === to) {
    return { value: input, warnings: [] };
  }
  const registry = opts.registry ?? DEFAULT_REGISTRY;
  const edges = registry.getEdges(component);
  const chain = findChain(edges, from, to);
  let current: unknown = input;
  const warnings: string[] = [];
  for (let i = 0; i < chain.length - 1; i += 1) {
    const stepFrom = chain[i]!;
    const stepTo = chain[i + 1]!;
    const migration = registry.getEdge(component, stepFrom, stepTo);
    if (!migration) {
      throw new ProtocolError(
        `Migration registry edge missing during chain walk: ${component} ${stepFrom}->${stepTo}`,
        { code: 'migration_failed', details: { component, from: stepFrom, to: stepTo } },
      );
    }
    let stepResult: { value: unknown; warnings: string[] };
    try {
      stepResult = migration.apply(current) as { value: unknown; warnings: string[] };
    } catch (err) {
      throw new ProtocolError(
        `Migration ${component} ${stepFrom}->${stepTo} threw: ${err instanceof Error ? err.message : String(err)}`,
        {
          code: 'migration_failed',
          details: { component, from: stepFrom, to: stepTo },
          cause: err,
        },
      );
    }
    current = stepResult.value;
    for (const w of stepResult.warnings) {
      warnings.push(`[${component} ${stepFrom}->${stepTo}] ${w}`);
    }
  }
  return { value: current, warnings };
}
