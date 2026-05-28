import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectTypescriptChanges } from '../../src/core/schema-changes/detectors/typescript.ts';

const FILE = 'app/types/public/api.ts';

describe('TypeScript detector', () => {
  it('add export → typescript.add_export', async () => {
    const before = `export function foo(): void {}`;
    const after = `export function foo(): void {}\nexport function bar(): void {}`;
    const r = await detectTypescriptChanges({ file: FILE, beforeText: before, afterText: after });
    const adds = r.filter((e) => e.kind === 'typescript.add_export');
    assert.equal(adds.length, 1);
    assert.equal(adds[0]!.objectName, 'bar');
    assert.equal(adds[0]!.additive, true);
  });

  it('remove export → typescript.remove_export (destructive)', async () => {
    const before = `export function foo(): void {}\nexport function bar(): void {}`;
    const after = `export function foo(): void {}`;
    const r = await detectTypescriptChanges({ file: FILE, beforeText: before, afterText: after });
    const removes = r.filter((e) => e.kind === 'typescript.remove_export');
    assert.equal(removes.length, 1);
    assert.equal(removes[0]!.objectName, 'bar');
    assert.equal(removes[0]!.additive, false);
  });

  it('change signature → typescript.change_signature (destructive)', async () => {
    const before = `export function foo(x: number): void {}`;
    const after = `export function foo(x: string): void {}`;
    const r = await detectTypescriptChanges({ file: FILE, beforeText: before, afterText: after });
    const changes = r.filter((e) => e.kind === 'typescript.change_signature');
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.objectName, 'foo');
    assert.equal(changes[0]!.additive, false);
  });

  it('unchanged file → no entries', async () => {
    const text = `export function foo(): void {}\nexport interface User { id: string }`;
    const r = await detectTypescriptChanges({ file: FILE, beforeText: text, afterText: text });
    assert.equal(r.length, 0);
  });

  it('export interface change → typescript.change_signature', async () => {
    const before = `export interface User { id: string }`;
    const after = `export interface User { id: string; name: string }`;
    const r = await detectTypescriptChanges({ file: FILE, beforeText: before, afterText: after });
    assert.ok(r.some((e) => e.kind === 'typescript.change_signature' && e.objectName === 'User'));
  });
});
