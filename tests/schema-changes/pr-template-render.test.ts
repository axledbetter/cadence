import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderManifestMarkdown, injectIntoPrBody, SCHEMA_CHANGES_MARKER } from '../../src/core/schema-changes/pr-template.ts';
import type { SchemaChangeEntry } from '../../src/core/schema-changes/types.ts';

function entry(over: Partial<SchemaChangeEntry>): SchemaChangeEntry {
  return {
    file: 'data/deltas/20260527.sql',
    kind: 'sql.add_column',
    objectName: 'users',
    subObjectName: 'last_login_at',
    additive: true,
    description: 'Add nullable timestamp',
    ...over,
  };
}

describe('renderManifestMarkdown', () => {
  it('empty → friendly placeholder', () => {
    const md = renderManifestMarkdown([]);
    assert.match(md, /No schema-defining files/);
  });

  it('one entry → table with header + row', () => {
    const md = renderManifestMarkdown([entry({})]);
    assert.match(md, /## Schema changes/);
    assert.match(md, /\| File \| Kind \| Object \| Additive \| Description \| Rollback \|/);
    assert.match(md, /sql\.add_column/);
    assert.match(md, /users\.last_login_at/);
    assert.match(md, /yes/);
  });

  it('rollback present → renders in table', () => {
    const md = renderManifestMarkdown([entry({ rollback: 'ALTER TABLE users DROP COLUMN x' })]);
    assert.match(md, /ALTER TABLE users DROP COLUMN x/);
  });

  it('consumers → renders affected-consumers footnote', () => {
    const md = renderManifestMarkdown([entry({ consumers: ['org/mobile', 'service:cron'] })]);
    assert.match(md, /Affected consumers:/);
    assert.match(md, /org\/mobile/);
  });

  it('escapes pipe characters in description', () => {
    const md = renderManifestMarkdown([entry({ description: 'col | with | pipes' })]);
    assert.match(md, /col \\\| with \\\| pipes/);
  });
});

describe('injectIntoPrBody', () => {
  it('replaces marker with rendered block', () => {
    const body = `# PR\n\nSome body.\n\n${SCHEMA_CHANGES_MARKER}\n\nFooter.`;
    const next = injectIntoPrBody(body, [entry({})]);
    assert.match(next, /## Schema changes/);
    assert.match(next, /Footer\./);
  });

  it('no marker → appends block', () => {
    const body = `# PR body without marker`;
    const next = injectIntoPrBody(body, [entry({})]);
    assert.match(next, /## Schema changes/);
  });

  it('re-render is idempotent (strips prior rendered block, preserves outside content)', () => {
    const body = `# PR\n\n${SCHEMA_CHANGES_MARKER}\nbody after`;
    const once = injectIntoPrBody(body, [entry({})]);
    const twice = injectIntoPrBody(once, [entry({ description: 'changed' })]);
    // Only one "## Schema changes" section after the second render.
    const occurrences = (twice.match(/## Schema changes/g) ?? []).length;
    assert.equal(occurrences, 1);
    assert.match(twice, /changed/);
    // Content outside the markers is preserved verbatim.
    assert.match(twice, /body after/);
    // Old rendered description is gone.
    assert.doesNotMatch(twice, /Add nullable timestamp/);
  });
});
