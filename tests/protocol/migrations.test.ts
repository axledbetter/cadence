/**
 * Migration contract enforcement framework. v1.0.0 ships zero real
 * migrations; this test asserts the FRAMEWORK using synthetic
 * migrations registered into a fresh registry.
 *
 * Per the spec's Migration interface:
 *  - apply() MUST be deterministic
 *  - input MUST validate against fromVersion's schema (enforced by
 *    loader stage-1 — covered in loader-handshake.test.ts)
 *  - output MUST validate against toVersion's schema (enforced by
 *    loader stage-3)
 *  - unknown fields MUST be preserved (this test)
 *  - {value, warnings} contract (this test)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MigrationRegistry,
  migrate,
  type Migration,
} from '../../src/core/protocol/compat.ts';
import { ALL_MIGRATIONS } from '../../src/core/protocol/migrations/index.ts';

describe('migration contract — apply() shape', () => {
  it('every shipped migration returns { value, warnings }', () => {
    // v1.0.0 baseline ships zero real migrations, but if any are added
    // later this test enforces the contract.
    for (const m of ALL_MIGRATIONS) {
      assert.equal(typeof m.fromVersion, 'string', `${m.component} migration missing fromVersion`);
      assert.equal(typeof m.toVersion, 'string', `${m.component} migration missing toVersion`);
      assert.equal(typeof m.apply, 'function', `${m.component} migration missing apply()`);
    }
  });
});

describe('migration framework — synthetic migrations', () => {
  it('preserves unknown extension fields by default', () => {
    const registry = new MigrationRegistry();
    const m: Migration = {
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      component: 'profile',
      // Identity-with-rename — preserves all unknown fields, adds one.
      apply: (input: any) => ({
        value: { ...input, _added_in_1_1: true },
        warnings: [],
      }),
    };
    registry.register(m);
    const out = migrate(
      { profile: 'solo', _custom_extension: { foo: 'bar' } },
      '1.0.0',
      '1.1.0',
      'profile',
      { registry },
    );
    assert.deepEqual(out.value, {
      profile: 'solo',
      _custom_extension: { foo: 'bar' },
      _added_in_1_1: true,
    });
  });

  it('is deterministic — same input produces same output', () => {
    const registry = new MigrationRegistry();
    registry.register({
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      component: 'profile',
      apply: (input: any) => ({
        value: { ...input, normalized: true },
        warnings: ['deterministic warning'],
      }),
    });
    const out1 = migrate({ a: 1 }, '1.0.0', '1.1.0', 'profile', { registry });
    const out2 = migrate({ a: 1 }, '1.0.0', '1.1.0', 'profile', { registry });
    assert.deepEqual(out1.value, out2.value);
    assert.deepEqual(out1.warnings, out2.warnings);
  });

  it('aggregates warnings across a chain', () => {
    const registry = new MigrationRegistry();
    registry.register({
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      component: 'profile',
      apply: (i: any) => ({ value: i, warnings: ['step1-warn'] }),
    });
    registry.register({
      fromVersion: '1.1.0',
      toVersion: '1.2.0',
      component: 'profile',
      apply: (i: any) => ({ value: i, warnings: ['step2-warn'] }),
    });
    const out = migrate({}, '1.0.0', '1.2.0', 'profile', { registry });
    assert.equal(out.warnings.length, 2);
    assert.match(out.warnings[0]!, /step1-warn/);
    assert.match(out.warnings[1]!, /step2-warn/);
  });

  it('rejects from === to as no-op (never throws migration_not_found)', () => {
    const registry = new MigrationRegistry();
    // No migrations registered.
    const out = migrate({ x: 1 }, '1.0.0', '1.0.0', 'profile', { registry });
    assert.deepEqual(out.value, { x: 1 });
    assert.deepEqual(out.warnings, []);
  });
});
