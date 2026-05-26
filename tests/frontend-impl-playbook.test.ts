// tests/frontend-impl-playbook.test.ts
//
// Skill-content invariant tests for the Layer 1 frontend playbook. These
// guard against accidental deletion of the load-bearing anchors that the
// future dispatcher integration depends on. The tests use stable section
// markers ("REQUIRED:", "DETECT THE PROJECT'S STACK FIRST") rather than
// loose prose so the assertions survive routine copy edits.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_PATH = path.resolve(__dirname, '..', 'skills', 'frontend-impl-playbook', 'SKILL.md');

function readSkill(): string {
  return fs.readFileSync(SKILL_PATH, 'utf8');
}

describe('frontend-impl-playbook skill', () => {
  it('exists at the expected path', () => {
    assert.ok(fs.existsSync(SKILL_PATH), `skill should exist at ${SKILL_PATH}`);
  });

  it('has YAML frontmatter with name + description', () => {
    const body = readSkill();
    assert.match(body, /^---\s*\nname:\s*frontend-impl-playbook\s*\ndescription:\s*\S/m);
  });

  it('contains the stack-detection anchor', () => {
    const body = readSkill();
    assert.match(body, /DETECT THE PROJECT'S STACK FIRST/);
    // The body must mention all three signal sources by name.
    assert.match(body, /package\.json/);
    assert.match(body, /components\.json/);
    assert.match(body, /tailwind\.config/);
  });

  it('contains stack-aware library examples (not shadcn-only)', () => {
    const body = readSkill();
    // Each library family must appear in the examples / detection list.
    for (const lib of ['shadcn', 'MUI', 'Chakra', 'Mantine', 'Bootstrap']) {
      assert.match(body, new RegExp(lib, 'i'), `playbook should mention ${lib}`);
    }
  });

  it('contains all five REQUIRED anchors', () => {
    const body = readSkill();
    assert.match(body, /## 1\. REQUIRED: Reuse existing primitives/);
    assert.match(body, /## 2\. REQUIRED: Design tokens only/);
    assert.match(body, /## 3\. REQUIRED: All four states by default/);
    assert.match(body, /## 4\. REQUIRED: Accessibility baseline/);
    assert.match(body, /## 5\. REQUIRED: Mobile-first responsive/);
  });

  it('explicitly names the four async states', () => {
    const body = readSkill();
    assert.match(body, /loading/);
    assert.match(body, /error/);
    assert.match(body, /empty/);
    assert.match(body, /success/);
  });

  it('points the impl agent at the audit script', () => {
    const body = readSkill();
    assert.match(body, /npm run audit:frontend|scripts\/audit-frontend\.ts/);
  });
});
