// tests/detect-frontend-stack.test.ts
//
// Tests for src/core/detect/frontend-stack.ts — mirrors the tmpdir-based
// pattern in tests/detect-stack.test.ts.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { detectFrontendStack } from '../src/core/detect/frontend-stack.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-fe-stack-'));
}

function writePkg(dir: string, pkg: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
}

describe('detectFrontendStack', () => {
  it('detects shadcn via components.json (canonical marker)', () => {
    const d = tmp();
    writePkg(d, { dependencies: { '@radix-ui/react-slot': '^1.0.0' } });
    fs.writeFileSync(path.join(d, 'components.json'), '{}');
    const r = detectFrontendStack(d);
    assert.equal(r.library, 'shadcn');
  });

  it('detects shadcn from components.json alone (no specific Radix dep required)', () => {
    const d = tmp();
    writePkg(d, {});
    fs.writeFileSync(path.join(d, 'components.json'), '{}');
    const r = detectFrontendStack(d);
    assert.equal(r.library, 'shadcn');
  });

  it('detects MUI from @mui/material in devDependencies', () => {
    const d = tmp();
    writePkg(d, { devDependencies: { '@mui/material': '^5.0.0' } });
    const r = detectFrontendStack(d);
    assert.equal(r.library, 'mui');
  });

  it('detects Chakra', () => {
    const d = tmp();
    writePkg(d, { dependencies: { '@chakra-ui/react': '^2.0.0' } });
    const r = detectFrontendStack(d);
    assert.equal(r.library, 'chakra');
  });

  it('detects custom + hasTailwind for plain Tailwind project', () => {
    const d = tmp();
    writePkg(d, { devDependencies: { tailwindcss: '^3.0.0' } });
    fs.writeFileSync(path.join(d, 'tailwind.config.ts'), 'export default {}');
    const r = detectFrontendStack(d);
    assert.equal(r.library, 'custom');
    assert.equal(r.hasTailwind, true);
    assert.deepEqual(r.tailwindConfigs, ['tailwind.config.ts']);
  });

  it('returns unknown when no frontend markers', () => {
    const d = tmp();
    writePkg(d, {});
    const r = detectFrontendStack(d);
    assert.equal(r.library, 'unknown');
    assert.equal(r.hasTailwind, false);
    assert.equal(r.primitivesDir, null);
  });

  it('resolves primitivesDir when app/components/ui exists', () => {
    const d = tmp();
    writePkg(d, {});
    fs.mkdirSync(path.join(d, 'app', 'components', 'ui'), { recursive: true });
    const r = detectFrontendStack(d);
    assert.equal(r.primitivesDir, 'app/components/ui');
  });

  it('falls back to src/components/ui then components/ui', () => {
    const d = tmp();
    writePkg(d, {});
    fs.mkdirSync(path.join(d, 'src', 'components', 'ui'), { recursive: true });
    const r = detectFrontendStack(d);
    assert.equal(r.primitivesDir, 'src/components/ui');
  });

  it('does not throw on malformed package.json', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), '{ not json ');
    const r = detectFrontendStack(d);
    assert.equal(r.library, 'unknown');
  });
});
