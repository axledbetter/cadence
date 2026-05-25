// tests/migrate/package-root.test.ts
//
// Regression test for the bin smoke failure shipped in v5.2.0:
// schema-validator.ts and alias-resolver.ts resolved presets/aliases.lock.json
// relative to __dirname + ../../.. — which lands at <install>/dist/presets/ in
// the published tarball (where presets/ actually lives at <install>/presets/).
// The fix routes both through findPackageRoot() in src/cli/_pkg-root.ts.
//
// These tests pin the helper's contract from the migrate module's perspective.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findPackageRoot, requirePackageRoot } from '../../src/cli/_pkg-root.ts';

describe('findPackageRoot (consumed from src/core/migrate)', () => {
  it('locates the package root containing @delegance/cadence', () => {
    const root = findPackageRoot(import.meta.url);
    assert.ok(root, 'findPackageRoot should return a non-null path');
    const pkg = JSON.parse(fs.readFileSync(path.join(root!, 'package.json'), 'utf8')) as { name?: string };
    assert.equal(pkg.name, '@delegance/cadence');
  });

  it('returns the same root when called repeatedly', () => {
    const r1 = findPackageRoot(import.meta.url);
    const r2 = findPackageRoot(import.meta.url);
    assert.equal(r1, r2);
  });

  it('package root contains presets/ with aliases.lock.json + schemas/migrate.schema.json', () => {
    const root = requirePackageRoot(import.meta.url);
    assert.ok(fs.existsSync(path.join(root, 'presets', 'aliases.lock.json')),
      'presets/aliases.lock.json must exist relative to package root');
    assert.ok(fs.existsSync(path.join(root, 'presets', 'schemas', 'migrate.schema.json')),
      'presets/schemas/migrate.schema.json must exist relative to package root');
  });

  it('requirePackageRoot throws clearly when given an unparseable url', () => {
    assert.throws(
      () => requirePackageRoot('file:///nonexistent/dir/that/does/not/exist/file.js'),
      /Could not locate package root/,
    );
  });
});
