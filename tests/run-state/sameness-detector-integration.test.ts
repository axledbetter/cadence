// Integration / golden smoke tests for the v7.10.0 sameness detector.
//
// Two-pronged verification of "is the detector actually wired in?" given
// that the consumer is an LLM agent following skills/autopilot/SKILL.md
// rather than an executable orchestrator:
//
//   1. SKILL.md mentions the detector in each of the three retry-loop
//      steps (Step 4 validate, Step 7 codex review, Step 8 bugbot).
//   2. The compiled subpath export (`./run-state/sameness-detector`) emits
//      the expected files and exports the documented symbols when loaded
//      directly from disk.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('sameness-detector / SKILL.md integration', () => {
  const skillPath = path.join(REPO_ROOT, 'skills', 'autopilot', 'SKILL.md');
  const skillBody = fs.readFileSync(skillPath, 'utf8');

  it('SKILL.md references computeFingerprint and shouldEscalate', () => {
    assert.match(
      skillBody,
      /computeFingerprint/,
      'SKILL.md must mention computeFingerprint',
    );
    assert.match(
      skillBody,
      /shouldEscalate/,
      'SKILL.md must mention shouldEscalate',
    );
  });

  it('Step 4 (validate) retry block references the detector', () => {
    // Pull the Step 4 section out and assert it mentions the detector.
    const step4 = skillBody.match(/### Step 4: Validate[\s\S]*?(?=### Step 5)/);
    assert.ok(step4, 'must find Step 4 section');
    assert.match(step4[0], /sameness-detector/);
    assert.match(step4[0], /phase: 'validate'/);
  });

  it('Step 7 (codex PR review) retry block references the detector', () => {
    const step7 = skillBody.match(/### Step 7: Codex PR review[\s\S]*?(?=### Step 8)/);
    assert.ok(step7, 'must find Step 7 section');
    assert.match(step7[0], /sameness-detector/);
    assert.match(step7[0], /phase: 'codex-review'/);
  });

  it('Step 8 (bugbot) retry block references the detector', () => {
    const step8 = skillBody.match(/### Step 8: Bugbot triage \+ fix[\s\S]*?(?=### Step 9|## Retry-loop)/);
    assert.ok(step8, 'must find Step 8 section');
    assert.match(step8[0], /sameness-detector/);
    assert.match(step8[0], /phase: 'bugbot'/);
  });

  it('SKILL.md documents the new public subpath import', () => {
    // v8.0.0 — package renamed to @delegance/cadence. The SKILL.md import
    // path was updated accordingly. Accept either name during the deprecation
    // window so out-of-tree forks don't break.
    assert.match(
      skillBody,
      /@delegance\/(cadence|claude-autopilot)\/run-state\/sameness-detector/,
      'SKILL.md must document the public subpath import (cadence or legacy claude-autopilot)',
    );
  });
});

describe('sameness-detector / compiled package subpath export', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  );
  const subpath = pkg.exports['./run-state/sameness-detector'];

  it('package.json exports the sameness-detector subpath', () => {
    assert.ok(subpath, 'subpath export must exist');
    assert.ok(subpath.types, 'subpath must have types entry');
    assert.ok(subpath.default, 'subpath must have default entry');
  });

  it('compiled output files exist at the declared paths (if build has been run)', (t) => {
    const distJs = path.join(REPO_ROOT, subpath.default.replace(/^\.\//, ''));
    const distDts = path.join(REPO_ROOT, subpath.types.replace(/^\.\//, ''));
    if (!fs.existsSync(distJs)) {
      // The full suite runs `prepublishOnly` which runs `npm run build`
      // first. In ad-hoc dev runs (just `node --test`), dist/ may be empty.
      // Skip rather than fail in that case so the test isn't flaky on
      // a clean checkout — packaging-time CI workflows still catch this.
      t.skip(`dist not built; expected ${distJs} (run \`npm run build\` first)`);
      return;
    }
    assert.ok(fs.existsSync(distDts), 'compiled .d.ts must exist');
  });

  it('compiled module exports computeFingerprint and shouldEscalate (if built)', async (t) => {
    const distJs = path.join(REPO_ROOT, subpath.default.replace(/^\.\//, ''));
    if (!fs.existsSync(distJs)) {
      t.skip('dist not built; skipping compiled-module import smoke');
      return;
    }
    const mod = await import(pathToFileURL(distJs).href);
    assert.equal(typeof mod.computeFingerprint, 'function');
    assert.equal(typeof mod.shouldEscalate, 'function');
    assert.equal(typeof mod.isSameFailure, 'function');
    assert.equal(typeof mod.stripVolatileTokens, 'function');

    // Smoke-test the runtime behavior end-to-end through the compiled
    // entry point, not the source. This catches "build emitted the file
    // but the export shape regressed" — distinct from typecheck.
    const fp = mod.computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/x.ts:1',
      errorMessage: 'boom',
    });
    assert.equal(typeof fp.hash, 'string');
    assert.equal(fp.hash.length, 64);
    const decision = mod.shouldEscalate([fp, fp]);
    assert.equal(decision.escalate, true);
  });
});
