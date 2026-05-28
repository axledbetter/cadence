import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectGraphqlChanges } from '../../src/core/schema-changes/detectors/graphql.ts';

const FILE = 'schema.graphql';

describe('GraphQL detector', () => {
  it('add field → graphql.add_field', async () => {
    const before = `type User { id: ID! name: String }`;
    const after = `type User { id: ID! name: String email: String }`;
    const r = await detectGraphqlChanges({ file: FILE, beforeText: before, afterText: after });
    assert.equal(r.length, 1);
    assert.equal(r[0]!.kind, 'graphql.add_field');
    assert.equal(r[0]!.objectName, 'User');
    assert.equal(r[0]!.subObjectName, 'email');
    assert.equal(r[0]!.additive, true);
  });

  it('remove field → graphql.remove_field (destructive)', async () => {
    const before = `type User { id: ID! name: String email: String }`;
    const after = `type User { id: ID! name: String }`;
    const r = await detectGraphqlChanges({ file: FILE, beforeText: before, afterText: after });
    assert.equal(r.length, 1);
    assert.equal(r[0]!.kind, 'graphql.remove_field');
    assert.equal(r[0]!.subObjectName, 'email');
    assert.equal(r[0]!.additive, false);
  });

  it('deprecate field → graphql.deprecate_field', async () => {
    const before = `type User { id: ID! name: String }`;
    const after = `type User { id: ID! name: String @deprecated(reason: "use fullName") }`;
    const r = await detectGraphqlChanges({ file: FILE, beforeText: before, afterText: after });
    assert.equal(r.length, 1);
    assert.equal(r[0]!.kind, 'graphql.deprecate_field');
  });

  it('add enum value → graphql.add_enum_value', async () => {
    const before = `enum Color { RED BLUE }`;
    const after = `enum Color { RED BLUE GREEN }`;
    const r = await detectGraphqlChanges({ file: FILE, beforeText: before, afterText: after });
    assert.equal(r.length, 1);
    assert.equal(r[0]!.kind, 'graphql.add_enum_value');
    assert.equal(r[0]!.subObjectName, 'GREEN');
  });

  it('remove enum value → graphql.remove_enum_value', async () => {
    const before = `enum Color { RED BLUE GREEN }`;
    const after = `enum Color { RED BLUE }`;
    const r = await detectGraphqlChanges({ file: FILE, beforeText: before, afterText: after });
    assert.equal(r.length, 1);
    assert.equal(r[0]!.kind, 'graphql.remove_enum_value');
    assert.equal(r[0]!.subObjectName, 'GREEN');
    assert.equal(r[0]!.additive, false);
  });

  it('new type → all fields are add entries', async () => {
    const after = `type Account { id: ID! name: String }`;
    const r = await detectGraphqlChanges({ file: FILE, beforeText: '', afterText: after });
    assert.equal(r.length, 2);
    assert.ok(r.every((e) => e.kind === 'graphql.add_field'));
  });

  it('unchanged schema → no entries', async () => {
    const text = `type User { id: ID! }`;
    const r = await detectGraphqlChanges({ file: FILE, beforeText: text, afterText: text });
    assert.equal(r.length, 0);
  });

  it('unparseable schema → unknown.unparseable', async () => {
    const r = await detectGraphqlChanges({ file: FILE, beforeText: '', afterText: 'this is not graphql' });
    assert.equal(r[0]!.kind, 'unknown.unparseable');
  });

  it('removed enum type emits remove_enum_value entries (bugbot fix)', async () => {
    const before = `enum Color { RED BLUE GREEN }\ntype User { id: ID! }`;
    const after = `type User { id: ID! }`;
    const r = await detectGraphqlChanges({ file: FILE, beforeText: before, afterText: after });
    const enumRemoves = r.filter((e) => e.kind === 'graphql.remove_enum_value');
    assert.equal(enumRemoves.length, 3);
    assert.deepEqual(new Set(enumRemoves.map((e) => e.subObjectName)), new Set(['RED', 'BLUE', 'GREEN']));
  });
});
