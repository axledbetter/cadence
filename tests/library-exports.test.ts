// v7.3.0 — library export surface smoke tests.
//
// Verifies the curated library API in src/index.ts:
//   1. All declared exports actually resolve at runtime (no stale paths).
//   2. The exports keep their declared signatures (functions are callable
//      with the documented options shape).
//   3. The package.json `exports` map points at the right files.
//
// This is the surface the v8 daemon will import. If it breaks here, the
// daemon's startup import chain breaks too.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as lib from '../src/index.ts';

describe('library export surface (v7.3.0)', () => {
  it('exports all declared run* functions', () => {
    const expected = [
      'runScan',
      'runScaffold',
      'runValidate',
      'runFix',
      'runCosts',
      'runReport',
      'runDoctor',
      'runSetup',
      'runDeploy',
      'runDeployStatus',
      'runDeployRollback',
    ];
    for (const name of expected) {
      assert.equal(
        typeof (lib as Record<string, unknown>)[name],
        'function',
        `expected ${name} to be exported as a function`,
      );
    }
  });

  it('exports detectProject helper', () => {
    assert.equal(typeof lib.detectProject, 'function');
  });

  it('detectProject returns expected shape on the autopilot repo itself', () => {
    // Walk up from this test file to the package root.
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(__dirname, '..');
    const detection = lib.detectProject(repoRoot);
    assert.equal(typeof detection.preset, 'string');
    assert.equal(typeof detection.testCommand, 'string');
    assert.ok(['high', 'low'].includes(detection.confidence));
    assert.equal(typeof detection.evidence, 'string');
  });

  it('package.json `exports` map points at compiled paths only', () => {
    // We don't want consumers importing from `dist/` paths directly when
    // the package-name import works. Verify the "." entry uses dist/.
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const dot = pkg.exports['.'];
    assert.ok(dot.types, 'has types entry');
    assert.ok(dot.default, 'has default (runtime) entry');
    assert.match(dot.types, /^\.\/dist\//, 'types points at dist/');
    assert.match(dot.default, /^\.\/dist\//, 'default points at dist/');
    // Exports map intentionally does NOT expose ./cli/*, ./core/*, etc.
    // Consumers who need internals can deep-import via a deliberate
    // unsupported path. Public subpath exports as of v7.11.0:
    //   - ./run-state/sameness-detector (added v7.10.0)
    //   - ./concurrent-dispatch (added v7.11.0)
    const supportedKeys = Object.keys(pkg.exports).sort();
    assert.deepEqual(
      supportedKeys,
      [
        '.',
        './bin/claude-autopilot.js',
        './bin/guardrail.js',
        './concurrent-dispatch',
        './package.json',
        './run-state/sameness-detector',
      ].sort(),
      'export map shape is the locked v7.11.0 set',
    );
    // Verify the sameness-detector subpath points at compiled output.
    const sd = pkg.exports['./run-state/sameness-detector'];
    assert.ok(sd, 'has sameness-detector subpath export');
    assert.match(sd.types, /^\.\/dist\//, 'sameness-detector types in dist/');
    assert.match(sd.default, /^\.\/dist\//, 'sameness-detector default in dist/');
    // Verify the concurrent-dispatch subpath points at compiled output.
    const cd = pkg.exports['./concurrent-dispatch'];
    assert.ok(cd, 'has concurrent-dispatch subpath export');
    assert.match(cd.types, /^\.\/dist\//, 'concurrent-dispatch types in dist/');
    assert.match(cd.default, /^\.\/dist\//, 'concurrent-dispatch default in dist/');
  });
});
