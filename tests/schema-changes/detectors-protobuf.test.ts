import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectProtobufChanges } from '../../src/core/schema-changes/detectors/protobuf.ts';

const FILE = 'api/user.proto';

describe('Protobuf detector', () => {
  it('add field → protobuf.add_field', async () => {
    const before = `
syntax = "proto3";
message User {
  string id = 1;
  string name = 2;
}
`;
    const after = `
syntax = "proto3";
message User {
  string id = 1;
  string name = 2;
  string email = 3;
}
`;
    const r = await detectProtobufChanges({ file: FILE, beforeText: before, afterText: after });
    const adds = r.filter((e) => e.kind === 'protobuf.add_field');
    assert.equal(adds.length, 1);
    assert.equal(adds[0]!.objectName, 'User');
    assert.equal(adds[0]!.subObjectName, 'email');
    assert.equal(adds[0]!.additive, true);
  });

  it('deprecate field → protobuf.deprecate_field', async () => {
    const before = `
syntax = "proto3";
message User { string id = 1; }
`;
    const after = `
syntax = "proto3";
message User { string id = 1 [deprecated=true]; }
`;
    const r = await detectProtobufChanges({ file: FILE, beforeText: before, afterText: after });
    assert.ok(r.some((e) => e.kind === 'protobuf.deprecate_field' && e.subObjectName === 'id'));
  });

  it('reserve field → protobuf.reserve_field', async () => {
    const before = `
syntax = "proto3";
message User { string id = 1; }
`;
    const after = `
syntax = "proto3";
message User { string id = 1; reserved 5, 6, "old_field"; }
`;
    const r = await detectProtobufChanges({ file: FILE, beforeText: before, afterText: after });
    const reserves = r.filter((e) => e.kind === 'protobuf.reserve_field');
    assert.ok(reserves.length >= 1);
  });

  it('unchanged proto → no entries', async () => {
    const text = `syntax = "proto3"; message U { string id = 1; }`;
    const r = await detectProtobufChanges({ file: FILE, beforeText: text, afterText: text });
    assert.equal(r.length, 0);
  });

  it('remove field → unknown.unsupported_kind (destructive, bugbot fix)', async () => {
    const before = `syntax = "proto3"; message User { string id = 1; string name = 2; }`;
    const after = `syntax = "proto3"; message User { string id = 1; }`;
    const r = await detectProtobufChanges({ file: FILE, beforeText: before, afterText: after });
    const removes = r.filter((e) => e.kind === 'unknown.unsupported_kind' && /Remove field/.test(e.description));
    assert.equal(removes.length, 1);
    assert.equal(removes[0]!.subObjectName, 'name');
    assert.equal(removes[0]!.additive, false);
  });

  it('remove entire message → emits one entry per pre-existing field (bugbot fix)', async () => {
    const before = `syntax = "proto3"; message Dead { string id = 1; string note = 2; }`;
    const after = `syntax = "proto3";`;
    const r = await detectProtobufChanges({ file: FILE, beforeText: before, afterText: after });
    assert.ok(r.length >= 2);
    assert.ok(r.every((e) => e.kind === 'unknown.unsupported_kind'));
    assert.ok(r.every((e) => e.additive === false));
  });
});
