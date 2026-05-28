import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectOpenapiChanges } from '../../src/core/schema-changes/detectors/openapi.ts';

const FILE = 'openapi.yaml';

const BASE = `
openapi: 3.0.0
info:
  title: t
  version: '1'
paths:
  /users:
    get:
      responses:
        '200':
          description: ok
`;

describe('OpenAPI detector', () => {
  it('add endpoint → openapi.add_endpoint', async () => {
    const after = `
openapi: 3.0.0
info:
  title: t
  version: '1'
paths:
  /users:
    get:
      responses: { '200': { description: ok } }
  /posts:
    get:
      responses: { '200': { description: ok } }
`;
    const r = await detectOpenapiChanges({ file: FILE, beforeText: BASE, afterText: after });
    assert.ok(r.some((e) => e.kind === 'openapi.add_endpoint' && e.objectName === '/posts'));
  });

  it('remove endpoint → openapi.remove_endpoint (destructive)', async () => {
    const after = `
openapi: 3.0.0
info:
  title: t
  version: '1'
paths: {}
`;
    const r = await detectOpenapiChanges({ file: FILE, beforeText: BASE, afterText: after });
    assert.equal(r.length, 1);
    assert.equal(r[0]!.kind, 'openapi.remove_endpoint');
    assert.equal(r[0]!.additive, false);
  });

  it('change response → openapi.change_response', async () => {
    const after = `
openapi: 3.0.0
info:
  title: t
  version: '1'
paths:
  /users:
    get:
      responses:
        '200':
          description: different
`;
    const r = await detectOpenapiChanges({ file: FILE, beforeText: BASE, afterText: after });
    assert.ok(r.some((e) => e.kind === 'openapi.change_response'));
  });

  it('change request body → openapi.change_request', async () => {
    const before = `
openapi: 3.0.0
info: { title: t, version: '1' }
paths:
  /users:
    post:
      requestBody: { content: { 'application/json': { schema: { type: object } } } }
      responses: { '200': { description: ok } }
`;
    const after = `
openapi: 3.0.0
info: { title: t, version: '1' }
paths:
  /users:
    post:
      requestBody: { content: { 'application/json': { schema: { type: string } } } }
      responses: { '200': { description: ok } }
`;
    const r = await detectOpenapiChanges({ file: FILE, beforeText: before, afterText: after });
    assert.ok(r.some((e) => e.kind === 'openapi.change_request'));
  });

  it('unchanged spec → no entries', async () => {
    const r = await detectOpenapiChanges({ file: FILE, beforeText: BASE, afterText: BASE });
    assert.equal(r.length, 0);
  });
});
