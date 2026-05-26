/**
 * resolveProfile() — path-safety + precedence + parsing tests.
 *
 * Covers the path-safety contract from the spec (revised pass 3
 * CRITICAL #2), the file precedence chain, the `.autopilot/profile`
 * parsing rules, and source-tag accuracy.
 *
 * NOTE: `loadProfileByName` is NOT re-exported from the package index;
 * we test it directly via `_loadProfileByNameForTest` (test-only seam).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  resolveProfile,
  _loadProfileByNameForTest,
  _parseProfileFileForTest,
  _resetSchemaCache,
} from '../../src/core/profile/resolver.ts';
import { ProfileResolutionError } from '../../src/core/profile/types.ts';

function mkTempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-profile-'));
}

function writeProfileFile(cwd: string, contents: string): void {
  const dir = path.join(cwd, '.autopilot');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile'), contents, 'utf8');
}

describe('resolveProfile — default fallback', () => {
  beforeEach(() => _resetSchemaCache());

  it('returns `solo` when no file, no env, no flag', () => {
    const cwd = mkTempCwd();
    const r = resolveProfile({ cwd });
    assert.equal(r.name, 'solo');
    assert.equal(r.source, 'default');
    assert.equal(r.config.profile, 'solo');
    assert.equal(r.config.auto_merge, true);
    assert.deepEqual(r.config.codex_passes, { low: 1, medium: 2, high: 3 });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('resolveProfile — precedence (file < env < flag)', () => {
  beforeEach(() => _resetSchemaCache());

  it('uses file when only file is set', () => {
    const cwd = mkTempCwd();
    writeProfileFile(cwd, 'enterprise\n');
    const r = resolveProfile({ cwd });
    assert.equal(r.name, 'enterprise');
    assert.equal(r.source, 'file');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('env overrides file', () => {
    const cwd = mkTempCwd();
    writeProfileFile(cwd, 'enterprise\n');
    const r = resolveProfile({ cwd, envProfile: 'small-team' });
    assert.equal(r.name, 'small-team');
    assert.equal(r.source, 'env');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('flag overrides env and file', () => {
    const cwd = mkTempCwd();
    writeProfileFile(cwd, 'enterprise\n');
    const r = resolveProfile({ cwd, envProfile: 'small-team', flagProfile: 'learning' });
    assert.equal(r.name, 'learning');
    assert.equal(r.source, 'flag');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('empty env value treated as unset (falls through to file)', () => {
    const cwd = mkTempCwd();
    writeProfileFile(cwd, 'enterprise\n');
    const r = resolveProfile({ cwd, envProfile: '' });
    assert.equal(r.name, 'enterprise');
    assert.equal(r.source, 'file');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('whitespace-only env value treated as unset', () => {
    const cwd = mkTempCwd();
    writeProfileFile(cwd, 'enterprise\n');
    const r = resolveProfile({ cwd, envProfile: '   \t  ' });
    assert.equal(r.name, 'enterprise');
    assert.equal(r.source, 'file');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('empty flag value rejected with path_traversal code', () => {
    const cwd = mkTempCwd();
    assert.throws(
      () => resolveProfile({ cwd, flagProfile: '' }),
      (err: ProfileResolutionError) => {
        assert.equal(err.code, 'path_traversal');
        assert.equal(err.source, 'flag');
        return true;
      },
    );
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('resolveProfile — path-safety (file source)', () => {
  beforeEach(() => _resetSchemaCache());

  for (const evil of ['../solo', '/tmp/x', 'templates/foo', 'solo.yaml', '.hidden']) {
    it(`rejects \`${evil}\` from .autopilot/profile`, () => {
      const cwd = mkTempCwd();
      writeProfileFile(cwd, `${evil}\n`);
      assert.throws(
        () => resolveProfile({ cwd }),
        (err: ProfileResolutionError) => {
          assert.equal(err instanceof ProfileResolutionError, true);
          assert.ok(
            err.code === 'path_traversal' || err.code === 'parse_error',
            `expected path_traversal or parse_error, got ${err.code}`,
          );
          return true;
        },
      );
      fs.rmSync(cwd, { recursive: true, force: true });
    });
  }
});

describe('resolveProfile — path-safety (env source)', () => {
  beforeEach(() => _resetSchemaCache());

  it('rejects CLAUDE_AUTOPILOT_PROFILE=../../etc/passwd', () => {
    const cwd = mkTempCwd();
    assert.throws(
      () => resolveProfile({ cwd, envProfile: '../../etc/passwd' }),
      (err: ProfileResolutionError) => {
        assert.equal(err.code, 'path_traversal');
        assert.equal(err.source, 'env');
        return true;
      },
    );
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('resolveProfile — path-safety (flag source)', () => {
  beforeEach(() => _resetSchemaCache());

  it('rejects --profile ..', () => {
    const cwd = mkTempCwd();
    assert.throws(
      () => resolveProfile({ cwd, flagProfile: '..' }),
      (err: ProfileResolutionError) => {
        assert.equal(err.code, 'path_traversal');
        assert.equal(err.source, 'flag');
        return true;
      },
    );
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('rejects --profile templates/foo', () => {
    const cwd = mkTempCwd();
    assert.throws(
      () => resolveProfile({ cwd, flagProfile: 'templates/foo' }),
      (err: ProfileResolutionError) => {
        assert.equal(err.code, 'path_traversal');
        return true;
      },
    );
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('rejects an unknown but path-safe name', () => {
    const cwd = mkTempCwd();
    assert.throws(
      () => resolveProfile({ cwd, flagProfile: 'nonexistent' }),
      (err: ProfileResolutionError) => {
        assert.equal(err.code, 'unknown');
        assert.equal(err.source, 'flag');
        // Error message lists available profiles.
        assert.match(err.message, /Available:/);
        return true;
      },
    );
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('parseProfileFile — allowed forms', () => {
  beforeEach(() => _resetSchemaCache());

  for (const allowed of ['enterprise\n', 'enterprise   \n', 'enterprise\n\n', 'enterprise\n\n\n']) {
    it(`accepts ${JSON.stringify(allowed)}`, () => {
      assert.equal(_parseProfileFileForTest(allowed), 'enterprise');
    });
  }

  it('treats empty file as unset (returns null)', () => {
    assert.equal(_parseProfileFileForTest(''), null);
  });

  it('treats whitespace-only file as unset (returns null)', () => {
    assert.equal(_parseProfileFileForTest('   \n\t\n   \n'), null);
  });
});

describe('parseProfileFile — rejected forms', () => {
  beforeEach(() => _resetSchemaCache());

  it('rejects two non-empty lines (`enterprise\\nsolo\\n`)', () => {
    assert.throws(
      () => _parseProfileFileForTest('enterprise\nsolo\n'),
      (err: ProfileResolutionError) => {
        assert.equal(err.code, 'parse_error');
        assert.equal(err.source, 'file');
        return true;
      },
    );
  });

  it('rejects inline comment (`enterprise # comment`)', () => {
    assert.throws(
      () => _parseProfileFileForTest('enterprise # comment\n'),
      (err: ProfileResolutionError) => {
        assert.equal(err.code, 'parse_error');
        return true;
      },
    );
  });

  it('rejects embedded whitespace (`enter prise`)', () => {
    assert.throws(
      () => _parseProfileFileForTest('enter prise\n'),
      (err: ProfileResolutionError) => {
        assert.equal(err.code, 'parse_error');
        return true;
      },
    );
  });
});

describe('loadProfileByName — direct path-safety tests', () => {
  beforeEach(() => _resetSchemaCache());

  // These exercise the internal helper directly. The contract: the
  // path-safety gate fires BEFORE any readFileSync, so even strings that
  // would name a real file on disk after path-joining are rejected.
  for (const evil of ['../solo', 'templates/foo', 'solo.yaml', '../../etc/passwd', '.', '']) {
    it(`rejects loadProfileByName(${JSON.stringify(evil)})`, () => {
      assert.throws(
        () => _loadProfileByNameForTest(evil),
        (err: ProfileResolutionError) => {
          assert.equal(err instanceof ProfileResolutionError, true);
          // Either path_traversal (regex caught it) or unknown (stem
          // enumeration caught it). Both are acceptable — what matters
          // is that we never reach readFileSync with the input.
          assert.ok(
            err.code === 'path_traversal' || err.code === 'unknown',
            `expected path_traversal or unknown, got ${err.code}`,
          );
          return true;
        },
      );
    });
  }

  it('loads a real shipped profile by name', () => {
    const config = _loadProfileByNameForTest('solo');
    assert.equal(config.profile, 'solo');
    assert.deepEqual(config.codex_passes, { low: 1, medium: 2, high: 3 });
  });
});

describe('resolveProfile — filename-mismatch detection', () => {
  beforeEach(() => _resetSchemaCache());

  it('raises filename_mismatch when synthetic file disagrees with field', () => {
    // Build a synthetic package root where a profile YAML lies about its
    // own `profile:` field. The resolver should catch the mismatch.
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-fake-root-'));
    try {
      const profilesDir = path.join(fakeRoot, 'presets', 'profiles');
      const schemasDir = path.join(fakeRoot, 'presets', 'schemas');
      fs.mkdirSync(profilesDir, { recursive: true });
      fs.mkdirSync(schemasDir, { recursive: true });
      // Copy real schema in.
      const realRoot = path.resolve(import.meta.dirname ?? '', '..', '..');
      fs.copyFileSync(
        path.join(realRoot, 'presets', 'schemas', 'profile.schema.json'),
        path.join(schemasDir, 'profile.schema.json'),
      );
      // Synthetic profile file where stem ≠ `profile` field.
      fs.writeFileSync(
        path.join(profilesDir, 'mismatched.yaml'),
        'profile: solo\ndescription: lies\ncodex_passes:\n  low: 0\n  medium: 0\n  high: 0\n',
        'utf8',
      );
      assert.throws(
        () => _loadProfileByNameForTest('mismatched', { packageRoot: fakeRoot }),
        (err: ProfileResolutionError) => {
          assert.equal(err.code, 'filename_mismatch');
          return true;
        },
      );
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});

describe('resolveProfile — source tag accuracy', () => {
  beforeEach(() => _resetSchemaCache());

  it('reports `default` when nothing is set', () => {
    const cwd = mkTempCwd();
    assert.equal(resolveProfile({ cwd }).source, 'default');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('reports `file` when only file is set', () => {
    const cwd = mkTempCwd();
    writeProfileFile(cwd, 'small-team\n');
    assert.equal(resolveProfile({ cwd }).source, 'file');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('reports `env` when env is set (no file)', () => {
    const cwd = mkTempCwd();
    assert.equal(
      resolveProfile({ cwd, envProfile: 'small-team' }).source,
      'env',
    );
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('reports `flag` when flag is set (no file, no env)', () => {
    const cwd = mkTempCwd();
    assert.equal(
      resolveProfile({ cwd, flagProfile: 'small-team' }).source,
      'flag',
    );
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
