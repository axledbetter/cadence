// tests/audit-frontend.test.ts
//
// Per-rule + config + edge-case tests for the Layer 2 frontend audit.
// Mirrors the auditSourceForTest pattern from audit-supabase-imports.test.ts —
// drives the audit via string-in/findings-out (no disk I/O for rule tests).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
  auditSource,
  resolveConfigForTest,
  loadConfig,
  ConfigError,
  ParseFailureError,
  normalizeRepoRelative,
  applyIgnorePaths,
  isAuditableExt,
} from '../scripts/audit-frontend.ts';

const FAKE_FILE = 'app/components/fake.tsx';

function audit(src: string, config = {}) {
  return auditSource(FAKE_FILE, src, resolveConfigForTest(config), { allowParseFailures: false });
}

describe('forbidRawColorLiterals', () => {
  it('flags hex literal in JSX style prop', () => {
    const f = audit(`export const X = () => <div style={{ color: '#3b82f6' }} />;`);
    const errs = f.filter((x) => x.rule === 'forbidRawColorLiterals');
    assert.equal(errs.length, 1);
    assert.match(errs[0]!.message, /#3b82f6/);
  });

  it('does not flag theme tokens (var or CSS variable)', () => {
    const f = audit(`export const X = () => <div style={{ color: 'var(--brand)' }} />;`);
    assert.equal(f.filter((x) => x.rule === 'forbidRawColorLiterals').length, 0);
  });

  it('flags rgb() in JSX style', () => {
    const f = audit(`export const X = () => <div style={{ background: 'rgb(0, 0, 0)' }} />;`);
    assert.equal(f.filter((x) => x.rule === 'forbidRawColorLiterals').length, 1);
  });

  it('flags raw color in svg fill attribute', () => {
    const f = audit(`export const X = () => <svg fill="#fff" />;`);
    assert.equal(f.filter((x) => x.rule === 'forbidRawColorLiterals').length, 1);
  });

  it('rule can be disabled via config', () => {
    const f = audit(
      `export const X = () => <div style={{ color: '#3b82f6' }} />;`,
      { rules: { forbidRawColorLiterals: false } },
    );
    assert.equal(f.filter((x) => x.rule === 'forbidRawColorLiterals').length, 0);
  });
});

describe('requireAltOnImg', () => {
  it('flags <img> without alt', () => {
    const f = audit(`export const X = () => <img src="logo.png" />;`);
    const errs = f.filter((x) => x.rule === 'requireAltOnImg' && x.severity === 'error');
    assert.equal(errs.length, 1);
  });

  it('does not flag <img alt="Logo">', () => {
    const f = audit(`export const X = () => <img src="logo.png" alt="Logo" />;`);
    assert.equal(f.filter((x) => x.rule === 'requireAltOnImg' && x.severity === 'error').length, 0);
  });

  it('emits NOTE for alt="" decorative', () => {
    const f = audit(`export const X = () => <img src="logo.png" alt="" />;`);
    const notes = f.filter((x) => x.rule === 'requireAltOnImg' && x.severity === 'note');
    assert.equal(notes.length, 1);
  });
});

describe('requireAriaLabelOnIconButton', () => {
  it('flags icon-only Button without accessible name', () => {
    const src = `
      import { Button } from 'ui';
      import { TrashIcon } from 'lucide';
      export const X = () => <Button><TrashIcon /></Button>;
    `;
    const f = audit(src);
    const errs = f.filter((x) => x.rule === 'requireAriaLabelOnIconButton');
    assert.equal(errs.length, 1);
  });

  it('passes with aria-label', () => {
    const src = `
      import { Button } from 'ui';
      import { TrashIcon } from 'lucide';
      export const X = () => <Button aria-label="Delete row"><TrashIcon /></Button>;
    `;
    const f = audit(src);
    assert.equal(f.filter((x) => x.rule === 'requireAriaLabelOnIconButton').length, 0);
  });

  it('passes with sr-only text', () => {
    const src = `
      import { Button } from 'ui';
      import { TrashIcon } from 'lucide';
      export const X = () => (
        <Button>
          <TrashIcon />
          <span className="sr-only">Delete row</span>
        </Button>
      );
    `;
    const f = audit(src);
    assert.equal(f.filter((x) => x.rule === 'requireAriaLabelOnIconButton').length, 0);
  });

  it('passes with visible text child', () => {
    const src = `
      import { Button } from 'ui';
      export const X = () => <Button><TrashIcon />Delete</Button>;
    `;
    const f = audit(src);
    assert.equal(f.filter((x) => x.rule === 'requireAriaLabelOnIconButton').length, 0);
  });

  it('passes with asChild (Radix slot)', () => {
    const src = `
      import { Button } from 'ui';
      export const X = () => <Button asChild><a href="/x">Go</a></Button>;
    `;
    const f = audit(src);
    assert.equal(f.filter((x) => x.rule === 'requireAriaLabelOnIconButton').length, 0);
  });
});

describe('forbidInteractiveDiv', () => {
  it('flags <div onClick> with no role/keyboard/tabIndex', () => {
    const f = audit(`export const X = () => <div onClick={() => {}}>X</div>;`);
    const errs = f.filter((x) => x.rule === 'forbidInteractiveDiv');
    assert.equal(errs.length, 1);
    assert.match(errs[0]!.message, /role/);
    assert.match(errs[0]!.message, /onKeyDown/);
    assert.match(errs[0]!.message, /tabIndex/);
  });

  it('passes with full keyboard + role + tabIndex', () => {
    const src = `
      export const X = () => (
        <div role="button" tabIndex={0} onKeyDown={() => {}} onClick={() => {}}>X</div>
      );
    `;
    const f = audit(src);
    assert.equal(f.filter((x) => x.rule === 'forbidInteractiveDiv').length, 0);
  });

  it('flags when only role is missing', () => {
    const src = `
      export const X = () => (
        <div tabIndex={0} onKeyDown={() => {}} onClick={() => {}}>X</div>
      );
    `;
    const f = audit(src);
    const errs = f.filter((x) => x.rule === 'forbidInteractiveDiv');
    assert.equal(errs.length, 1);
    assert.match(errs[0]!.message, /role/);
  });

  it('does not flag <div> without onClick', () => {
    const f = audit(`export const X = () => <div>X</div>;`);
    assert.equal(f.filter((x) => x.rule === 'forbidInteractiveDiv').length, 0);
  });
});

describe('requireLabelForInput', () => {
  it('flags <input id="email"> with no label', () => {
    const f = audit(`export const X = () => <input id="email" type="email" />;`);
    const errs = f.filter((x) => x.rule === 'requireLabelForInput');
    assert.equal(errs.length, 1);
  });

  it('passes <label htmlFor>...<input id /> sibling pair', () => {
    const src = `
      export const X = () => (
        <>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" />
        </>
      );
    `;
    const f = audit(src);
    assert.equal(f.filter((x) => x.rule === 'requireLabelForInput').length, 0);
  });

  it('passes shadcn <Label htmlFor>...<Input id />', () => {
    const src = `
      import { Label } from 'ui';
      import { Input } from 'ui';
      export const X = () => (
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" />
        </div>
      );
    `;
    const f = audit(src);
    assert.equal(f.filter((x) => x.rule === 'requireLabelForInput').length, 0);
  });

  it('passes wrapper label <label>Name<input/></label>', () => {
    const src = `
      export const X = () => (
        <label>Name<input type="text" /></label>
      );
    `;
    const f = audit(src);
    assert.equal(f.filter((x) => x.rule === 'requireLabelForInput').length, 0);
  });

  it('does not flag type="hidden"', () => {
    const f = audit(`export const X = () => <input type="hidden" value="x" />;`);
    assert.equal(f.filter((x) => x.rule === 'requireLabelForInput').length, 0);
  });

  it('does not flag type="submit"', () => {
    const f = audit(`export const X = () => <input type="submit" value="Go" />;`);
    assert.equal(f.filter((x) => x.rule === 'requireLabelForInput').length, 0);
  });

  it('passes with aria-label', () => {
    const f = audit(`export const X = () => <input aria-label="Search" />;`);
    assert.equal(f.filter((x) => x.rule === 'requireLabelForInput').length, 0);
  });

  it('flags shadcn <Input> with no label (not self-labeling by default)', () => {
    const src = `
      import { Input } from 'ui';
      export const X = () => <Input id="email" type="email" />;
    `;
    const f = audit(src);
    assert.equal(f.filter((x) => x.rule === 'requireLabelForInput').length, 1);
  });

  it('does not flag <TextField> (self-labeling component)', () => {
    const f = audit(`export const X = () => <TextField id="email" label="Email" />;`);
    assert.equal(f.filter((x) => x.rule === 'requireLabelForInput').length, 0);
  });
});

describe('parse failures', () => {
  it('throws ParseFailureError on broken JSX without --allow-parse-failures', () => {
    const broken = fs.readFileSync(
      path.resolve(__dirname, 'fixtures', 'audit-frontend', 'broken.tsx'),
      'utf8',
    );
    assert.throws(
      () => auditSource('broken.tsx', broken, resolveConfigForTest(), { allowParseFailures: false }),
      (err: unknown) => err instanceof ParseFailureError,
    );
  });

  it('returns [] with --allow-parse-failures', () => {
    const broken = fs.readFileSync(
      path.resolve(__dirname, 'fixtures', 'audit-frontend', 'broken.tsx'),
      'utf8',
    );
    const f = auditSource('broken.tsx', broken, resolveConfigForTest(), { allowParseFailures: true });
    assert.equal(f.length, 0);
  });
});

describe('config loading', () => {
  function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fe-cfg-'));
  }
  const REPO_SCHEMA = path.resolve(__dirname, '..', 'presets', 'schemas', 'frontend-quality.schema.json');

  it('missing config file → defaults applied', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const cfg = loadConfig(dir, REPO_SCHEMA);
    assert.equal(cfg.rules.forbidRawColorLiterals, true);
    assert.equal(cfg.rules.forbidMagicSpacing, false);
  });

  it('explicit rules override defaults', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.mkdirSync(path.join(dir, '.autopilot'));
    fs.writeFileSync(
      path.join(dir, '.autopilot', 'frontend-quality.json'),
      JSON.stringify({ rules: { forbidRawColorLiterals: false } }),
    );
    const cfg = loadConfig(dir, REPO_SCHEMA);
    assert.equal(cfg.rules.forbidRawColorLiterals, false);
    assert.equal(cfg.rules.requireAltOnImg, true);
  });

  it('config typo at rule name → exit 2 (ConfigError)', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.mkdirSync(path.join(dir, '.autopilot'));
    fs.writeFileSync(
      path.join(dir, '.autopilot', 'frontend-quality.json'),
      JSON.stringify({ rules: { requireAltOnImages: false } }),
    );
    assert.throws(() => loadConfig(dir, REPO_SCHEMA), (e: unknown) => e instanceof ConfigError);
  });

  it('config typo at top level → ConfigError', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.mkdirSync(path.join(dir, '.autopilot'));
    fs.writeFileSync(
      path.join(dir, '.autopilot', 'frontend-quality.json'),
      JSON.stringify({ ignoredPaths: [] }), // typo: should be ignorePaths
    );
    assert.throws(() => loadConfig(dir, REPO_SCHEMA), (e: unknown) => e instanceof ConfigError);
  });

  it('malformed JSON → ConfigError', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.mkdirSync(path.join(dir, '.autopilot'));
    fs.writeFileSync(path.join(dir, '.autopilot', 'frontend-quality.json'), '{ not json ');
    assert.throws(() => loadConfig(dir, REPO_SCHEMA), (e: unknown) => e instanceof ConfigError);
  });

  it('path traversal in ignorePaths → rejected', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.mkdirSync(path.join(dir, '.autopilot'));
    fs.writeFileSync(
      path.join(dir, '.autopilot', 'frontend-quality.json'),
      JSON.stringify({ ignorePaths: ['../etc/passwd'] }),
    );
    assert.throws(() => loadConfig(dir, REPO_SCHEMA), (e: unknown) => e instanceof ConfigError);
  });
});

describe('rawColorAllowedFiles', () => {
  it('exempts matching file from forbidRawColorLiterals only', () => {
    const cfg = { rawColorAllowedFiles: ['app/components/fake.tsx'] };
    // Same file path as FAKE_FILE — should be exempt from raw-color
    const f = audit(`export const X = () => <div style={{ color: '#3b82f6' }} onClick={() => {}}>X</div>;`, cfg);
    assert.equal(f.filter((x) => x.rule === 'forbidRawColorLiterals').length, 0);
    // Other rules still fire — onClick div is missing a11y attrs
    assert.equal(f.filter((x) => x.rule === 'forbidInteractiveDiv').length, 1);
  });

  it('does not exempt a non-matching file', () => {
    const cfg = { rawColorAllowedFiles: ['app/components/theme.tsx'] };
    const f = audit(`export const X = () => <div style={{ color: '#3b82f6' }} />;`, cfg);
    assert.equal(f.filter((x) => x.rule === 'forbidRawColorLiterals').length, 1);
  });
});

describe('helpers', () => {
  it('normalizeRepoRelative rejects absolute paths', () => {
    assert.equal(normalizeRepoRelative('/etc/passwd'), null);
  });
  it('normalizeRepoRelative rejects .. segments', () => {
    assert.equal(normalizeRepoRelative('a/../b'), null);
  });
  it('normalizeRepoRelative accepts safe paths', () => {
    assert.equal(normalizeRepoRelative('app/components/button.tsx'), 'app/components/button.tsx');
  });
  it('applyIgnorePaths matches glob and excludes', () => {
    const filtered = applyIgnorePaths(
      ['app/x.tsx', 'app/x.stories.tsx', 'app/y.test.tsx'],
      ['**/*.stories.tsx', '**/*.test.tsx'],
    );
    assert.deepEqual(filtered, ['app/x.tsx']);
  });
  it('isAuditableExt accepts tsx/jsx only', () => {
    assert.equal(isAuditableExt('a.tsx'), true);
    assert.equal(isAuditableExt('a.jsx'), true);
    assert.equal(isAuditableExt('a.ts'), false);
    assert.equal(isAuditableExt('a.js'), false);
    assert.equal(isAuditableExt('a.css'), false);
  });
});
