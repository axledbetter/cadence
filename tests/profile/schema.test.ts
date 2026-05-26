/**
 * profile.schema.json — direct schema validation tests.
 *
 * Two halves:
 *  1. All 5 shipped profiles validate against the schema.
 *  2. Synthetic invalid documents fail with clear errors (wrong types,
 *     out-of-range integers, absolute audit_log_path, `..` escape,
 *     unknown top-level key, unknown nested key, missing required key).
 *
 * Filename ↔ profile field match is NOT exercised here — that's a
 * resolver-level check (schema has no access to filename context).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import Ajv, { type ValidateFunction } from 'ajv';

const PACKAGE_ROOT = path.resolve(import.meta.dirname ?? '', '..', '..');
const SCHEMA_PATH = path.join(PACKAGE_ROOT, 'presets', 'schemas', 'profile.schema.json');
const PROFILES_DIR = path.join(PACKAGE_ROOT, 'presets', 'profiles');

let validate: ValidateFunction;

before(() => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  validate = ajv.compile(schema);
});

const SHIPPED_PROFILES = ['solo', 'small-team', 'oss-maintainer', 'enterprise', 'learning'];

describe('profile.schema.json — shipped profiles', () => {
  for (const name of SHIPPED_PROFILES) {
    it(`validates ${name}.yaml`, () => {
      const raw = fs.readFileSync(path.join(PROFILES_DIR, `${name}.yaml`), 'utf8');
      const parsed = yaml.load(raw);
      const ok = validate(parsed);
      if (!ok) {
        const errors = (validate.errors ?? []).map(e => `${e.instancePath}: ${e.message}`).join('\n  ');
        assert.fail(`${name}.yaml failed schema:\n  ${errors}`);
      }
    });
  }

  it('shipped profiles directory contains exactly the 5 documented stems', () => {
    const stems = fs.readdirSync(PROFILES_DIR, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.yaml'))
      .map(e => e.name.slice(0, -'.yaml'.length))
      .sort();
    assert.deepEqual(stems, [...SHIPPED_PROFILES].sort());
  });
});

describe('profile.schema.json — synthetic valid minimal', () => {
  it('accepts a minimal valid profile (required keys only)', () => {
    const minimal = {
      profile: 'test',
      description: 'min',
      codex_passes: { low: 0, medium: 0, high: 0 },
    };
    assert.equal(validate(minimal), true);
  });

  it('accepts codex_passes.high=5 (boundary)', () => {
    const doc = {
      profile: 'test',
      description: 'boundary',
      codex_passes: { low: 5, medium: 5, high: 5 },
    };
    assert.equal(validate(doc), true);
  });
});

describe('profile.schema.json — synthetic invalid', () => {
  it('rejects missing required top-level key (`codex_passes`)', () => {
    const doc = { profile: 'test', description: 'no passes' };
    assert.equal(validate(doc), false);
  });

  it('rejects missing required nested key (`codex_passes.high`)', () => {
    const doc = {
      profile: 'test',
      description: 'no high',
      codex_passes: { low: 0, medium: 0 },
    };
    assert.equal(validate(doc), false);
  });

  it('rejects codex_passes.high=6 (out of range)', () => {
    const doc = {
      profile: 'test',
      description: 'oor',
      codex_passes: { low: 0, medium: 0, high: 6 },
    };
    assert.equal(validate(doc), false);
  });

  it('rejects codex_passes.low=-1 (out of range)', () => {
    const doc = {
      profile: 'test',
      description: 'neg',
      codex_passes: { low: -1, medium: 0, high: 0 },
    };
    assert.equal(validate(doc), false);
  });

  it('rejects codex_passes.medium as non-integer', () => {
    const doc = {
      profile: 'test',
      description: 'frac',
      codex_passes: { low: 0, medium: 1.5, high: 0 },
    };
    assert.equal(validate(doc), false);
  });

  it('rejects pause_at_steps=10 (out of range — max is 9)', () => {
    const doc = {
      profile: 'test',
      description: 'oor',
      codex_passes: { low: 0, medium: 0, high: 0 },
      pause_at_steps: [10],
    };
    assert.equal(validate(doc), false);
  });

  it('rejects pause_at_steps duplicates (uniqueItems)', () => {
    const doc = {
      profile: 'test',
      description: 'dup',
      codex_passes: { low: 0, medium: 0, high: 0 },
      pause_at_steps: [4, 4],
    };
    assert.equal(validate(doc), false);
  });

  it('rejects absolute audit_log_path (`/var/log/...`)', () => {
    const doc = {
      profile: 'test',
      description: 'absolute',
      codex_passes: { low: 0, medium: 0, high: 0 },
      audit_log_path: '/var/log/cadence/',
    };
    assert.equal(validate(doc), false);
  });

  it('rejects audit_log_path with `..` escape', () => {
    const doc = {
      profile: 'test',
      description: 'escape',
      codex_passes: { low: 0, medium: 0, high: 0 },
      audit_log_path: '../outside/',
    };
    assert.equal(validate(doc), false);
  });

  // bugbot MEDIUM — schema previously allowed `C:/...` Windows absolute
  // paths despite the description saying "repo-relative". Verify the
  // tightened regex rejects all common absolute / UNC / backslash cases.
  for (const evil of ['C:/outside/audit/', 'C:\\Windows\\Temp\\', '\\\\server\\share\\', 'audit\\subdir']) {
    it(`rejects audit_log_path platform-absolute / UNC: ${JSON.stringify(evil)}`, () => {
      const doc = {
        profile: 'test',
        description: 'evil',
        codex_passes: { low: 0, medium: 0, high: 0 },
        audit_log_path: evil,
      };
      assert.equal(validate(doc), false);
    });
    it(`rejects pr_template_path platform-absolute / UNC: ${JSON.stringify(evil)}`, () => {
      const doc = {
        profile: 'test',
        description: 'evil',
        codex_passes: { low: 0, medium: 0, high: 0 },
        pr_template_path: evil,
      };
      assert.equal(validate(doc), false);
    });
  }

  it('rejects pr_template_path with `..` escape', () => {
    const doc = {
      profile: 'test',
      description: 'escape',
      codex_passes: { low: 0, medium: 0, high: 0 },
      pr_template_path: '../outside.md',
    };
    assert.equal(validate(doc), false);
  });

  it('rejects unknown top-level key (additionalProperties: false)', () => {
    const doc = {
      profile: 'test',
      description: 'extra',
      codex_passes: { low: 0, medium: 0, high: 0 },
      unknownKey: true,
    };
    assert.equal(validate(doc), false);
  });

  it('rejects unknown nested key under codex_passes', () => {
    const doc = {
      profile: 'test',
      description: 'extra-nested',
      codex_passes: { low: 0, medium: 0, high: 0, critical: 1 },
    };
    assert.equal(validate(doc), false);
  });

  it('rejects unknown nested key under contributor_policy', () => {
    const doc = {
      profile: 'test',
      description: 'extra-nested',
      codex_passes: { low: 0, medium: 0, high: 0 },
      contributor_policy: {
        external_high_codex_passes: 3,
        membership_provider: 'github-org',
        extra: true,
      },
    };
    assert.equal(validate(doc), false);
  });

  it('rejects auto_merge as string', () => {
    const doc = {
      profile: 'test',
      description: 'bad-type',
      codex_passes: { low: 0, medium: 0, high: 0 },
      auto_merge: 'true',
    };
    assert.equal(validate(doc), false);
  });

  it('rejects contributor_policy.membership_provider with unknown enum value', () => {
    const doc = {
      profile: 'test',
      description: 'enum',
      codex_passes: { low: 0, medium: 0, high: 0 },
      contributor_policy: {
        external_high_codex_passes: 3,
        membership_provider: 'gitlab-group',
      },
    };
    assert.equal(validate(doc), false);
  });

  it('rejects profile name with invalid pattern (uppercase)', () => {
    const doc = {
      profile: 'Solo',
      description: 'bad-pattern',
      codex_passes: { low: 0, medium: 0, high: 0 },
    };
    assert.equal(validate(doc), false);
  });

  it('rejects empty description', () => {
    const doc = {
      profile: 'test',
      description: '',
      codex_passes: { low: 0, medium: 0, high: 0 },
    };
    assert.equal(validate(doc), false);
  });
});
