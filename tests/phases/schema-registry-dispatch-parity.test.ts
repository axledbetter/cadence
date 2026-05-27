/**
 * Drift guard: the JSON Schema enum, the PROVIDER_REGISTRY keys, and the
 * dispatcher's switch cases must stay in lock-step. If any of the three
 * lists drifts, profiles will validate but fail at runtime (or valid
 * routes will be rejected by the schema).
 *
 * Addresses codex CRITICAL #2 from plan v1 review.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_REGISTRY } from '../../src/core/phases/provider-registry.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadSchemaEnum(): string[] {
  const schemaPath = path.join(ROOT, 'presets/schemas/profile.schema.json');
  const raw = fs.readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(raw);
  const phaseRoute = schema.$defs?.phaseRoute;
  assert.ok(phaseRoute, 'profile.schema.json missing $defs.phaseRoute');
  const enumList = phaseRoute.properties?.provider?.enum;
  assert.ok(Array.isArray(enumList), '$defs.phaseRoute.properties.provider.enum must be an array');
  return [...enumList].sort();
}

function loadDispatcherProviders(): string[] {
  const dispatcherPath = path.join(ROOT, 'src/core/phases/dispatch.ts');
  const src = fs.readFileSync(dispatcherPath, 'utf8');
  const providers = new Set<string>();
  const re = /case\s+'([a-z][a-z0-9-]*)':/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    providers.add(m[1]!);
  }
  return [...providers].sort();
}

describe('schema, registry, and dispatch parity', () => {
  it('schema enum equals registry keys', () => {
    const schemaEnum = loadSchemaEnum();
    const registryKeys = Object.keys(PROVIDER_REGISTRY).sort();
    assert.deepEqual(schemaEnum, registryKeys);
  });

  it('every registry provider has a dispatcher case', () => {
    const registryKeys = Object.keys(PROVIDER_REGISTRY).sort();
    const dispatcherProviders = loadDispatcherProviders();
    for (const p of registryKeys) {
      assert.ok(
        dispatcherProviders.includes(p),
        `provider "${p}" in registry but missing from dispatch.ts switch`,
      );
    }
  });
});
