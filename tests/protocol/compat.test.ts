/**
 * satisfies() — exhaustive matrix for the 5-state enum, plus
 * normalization-equivalence ("1.2" vs "1.2.0") assertions.
 *
 * The classification policy (codex WARNING fix): the migration
 * registry is the source of truth for "is an adapter required?" —
 * adding an edge flips classification from older-supported to
 * older-needs-migration without code change.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  satisfies,
  MigrationRegistry,
  migrate,
  type Migration,
} from '../../src/core/protocol/compat.ts';
import { ProtocolError } from '../../src/core/protocol/errors.ts';

describe('satisfies() — five-state enum', () => {
  it('returns exact for identical versions', () => {
    assert.equal(satisfies('1.0.0', '1.0.0'), 'exact');
    assert.equal(satisfies('2.5.7', '2.5.7'), 'exact');
  });

  it('normalizes inputs (1.2 == 1.2.0)', () => {
    assert.equal(satisfies('1.2', '1.2.0'), 'exact');
    assert.equal(satisfies('1', '1.0.0'), 'exact');
  });

  it('returns older-supported when declared < current, same major, no migration', () => {
    assert.equal(satisfies('1.0.0', '1.2.0'), 'older-supported');
    assert.equal(satisfies('1.0.0', '1.0.5'), 'older-supported');
  });

  it('returns older-needs-migration when registry has an edge spanning the gap', () => {
    const registry = new MigrationRegistry();
    const m: Migration = {
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      component: 'profile',
      apply: (i: unknown) => ({ value: i, warnings: [] }),
    };
    registry.register(m);
    assert.equal(
      satisfies('1.0.0', '1.1.0', { registry, component: 'profile' }),
      'older-needs-migration',
    );
    // Across multiple registered edges (1.0 -> 1.1 -> 1.2):
    const m2: Migration = {
      fromVersion: '1.1.0',
      toVersion: '1.2.0',
      component: 'profile',
      apply: (i: unknown) => ({ value: i, warnings: [] }),
    };
    registry.register(m2);
    assert.equal(
      satisfies('1.0.0', '1.2.0', { registry, component: 'profile' }),
      'older-needs-migration',
    );
  });

  it('falls back to older-supported when registry has edges but no path', () => {
    const registry = new MigrationRegistry();
    registry.register({
      fromVersion: '0.5.0',
      toVersion: '0.6.0',
      component: 'profile',
      apply: (i: unknown) => ({ value: i, warnings: [] }),
    });
    // Asking about 1.0 -> 1.1 — registry has edges but none span this gap.
    assert.equal(
      satisfies('1.0.0', '1.1.0', { registry, component: 'profile' }),
      'older-supported',
    );
  });

  it('returns newer-unsupported when declared > supported, same major', () => {
    assert.equal(satisfies('1.3.0', '1.2.0'), 'newer-unsupported');
    assert.equal(satisfies('1.2.5', '1.2.0'), 'newer-unsupported');
  });

  it('returns major-incompatible across majors regardless of values', () => {
    assert.equal(satisfies('1.0.0', '2.0.0'), 'major-incompatible');
    assert.equal(satisfies('2.0.0', '1.0.0'), 'major-incompatible');
    assert.equal(satisfies('0.99.99', '1.0.0'), 'major-incompatible');
  });
});

describe('migrate() — pure / deterministic', () => {
  it('no-op when from === to (defensive)', () => {
    const out = migrate({ x: 1 }, '1.0.0', '1.0.0', 'profile');
    assert.deepEqual(out.value, { x: 1 });
    assert.deepEqual(out.warnings, []);
  });

  it('chains registered migrations in order', () => {
    const registry = new MigrationRegistry();
    const callOrder: string[] = [];
    registry.register({
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      component: 'profile',
      apply: (i: any) => {
        callOrder.push('1.0->1.1');
        return { value: { ...i, step1: true }, warnings: ['w1'] };
      },
    });
    registry.register({
      fromVersion: '1.1.0',
      toVersion: '1.2.0',
      component: 'profile',
      apply: (i: any) => {
        callOrder.push('1.1->1.2');
        return { value: { ...i, step2: true }, warnings: ['w2'] };
      },
    });
    const out = migrate({}, '1.0.0', '1.2.0', 'profile', { registry });
    assert.deepEqual(callOrder, ['1.0->1.1', '1.1->1.2']);
    assert.deepEqual(out.value, { step1: true, step2: true });
    assert.equal(out.warnings.length, 2);
    // Warnings are prefixed with the edge tag.
    assert.match(out.warnings[0]!, /profile 1\.0\.0->1\.1\.0/);
    assert.match(out.warnings[1]!, /profile 1\.1\.0->1\.2\.0/);
  });

  it('throws migration_not_found when no chain exists', () => {
    const registry = new MigrationRegistry();
    assert.throws(
      () => migrate({}, '1.0.0', '1.1.0', 'profile', { registry }),
      (err: unknown) => err instanceof ProtocolError && err.code === 'migration_not_found',
    );
  });

  it('catches thrown errors and wraps as migration_failed with cause', () => {
    const registry = new MigrationRegistry();
    registry.register({
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      component: 'profile',
      apply: () => {
        throw new Error('boom');
      },
    });
    try {
      migrate({}, '1.0.0', '1.1.0', 'profile', { registry });
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof ProtocolError);
      assert.equal((err as ProtocolError).code, 'migration_failed');
      assert.match((err as Error).message, /boom/);
    }
  });
});

describe('MigrationRegistry', () => {
  it('rejects duplicate edges', () => {
    const registry = new MigrationRegistry();
    const m: Migration = {
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      component: 'profile',
      apply: (i: unknown) => ({ value: i, warnings: [] }),
    };
    registry.register(m);
    assert.throws(() => registry.register(m), ProtocolError);
  });

  it('returns empty edges for unregistered component', () => {
    const registry = new MigrationRegistry();
    assert.deepEqual(registry.getEdges('skillFrontmatter'), []);
  });
});
