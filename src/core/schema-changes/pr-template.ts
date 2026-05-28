// src/core/schema-changes/pr-template.ts
//
// Renders a SchemaChangeEntry[] as a markdown table and injects it into
// a PR body via the <!-- cadence:schema-changes --> marker. Idempotent —
// re-running on an already-rendered body strips the old block first.

import type { SchemaChangeEntry } from './types.ts';

export const SCHEMA_CHANGES_MARKER = '<!-- cadence:schema-changes -->';
const SCHEMA_CHANGES_END_MARKER = '<!-- cadence:schema-changes:end -->';

function escapeMd(text: string | undefined): string {
  if (!text) return '';
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderManifestMarkdown(entries: SchemaChangeEntry[]): string {
  if (entries.length === 0) {
    return '## Schema changes\n\n_No schema-defining files were modified in this PR._';
  }
  const header = '## Schema changes\n\n| File | Kind | Object | Additive | Description | Rollback |\n|------|------|--------|----------|-------------|----------|';
  const rows: string[] = [];
  for (const e of entries) {
    const obj = [e.objectName, e.subObjectName].filter(Boolean).join('.');
    const additive = e.additive ? 'yes' : 'no';
    rows.push(`| \`${escapeMd(e.file)}\` | \`${e.kind}\` | \`${escapeMd(obj) || '-'}\` | ${additive} | ${escapeMd(e.description)} | ${escapeMd(e.rollback) || '-'} |`);
  }
  // Consumer footnote.
  const consumers = new Set<string>();
  for (const e of entries) {
    for (const c of e.consumers ?? []) consumers.add(c);
  }
  const footer = consumers.size > 0
    ? `\n\n**Affected consumers:** ${[...consumers].map((c) => `\`${c}\``).join(', ')}.`
    : '';
  return `${header}\n${rows.join('\n')}${footer}`;
}

/**
 * Replace the `<!-- cadence:schema-changes -->` marker (and any
 * previously-injected block) in `body` with the rendered manifest. If the
 * marker is absent, appends the block to the end of the body.
 */
export function injectIntoPrBody(body: string, entries: SchemaChangeEntry[]): string {
  const rendered = renderManifestMarkdown(entries);
  const block = `${SCHEMA_CHANGES_MARKER}\n${rendered}\n${SCHEMA_CHANGES_END_MARKER}`;

  // Strip any prior render between markers (idempotent re-render).
  const between = new RegExp(`${escapeRegExp(SCHEMA_CHANGES_MARKER)}[\\s\\S]*?${escapeRegExp(SCHEMA_CHANGES_END_MARKER)}`, 'g');
  let next = body.replace(between, block);

  // If no marker was present, replace the single marker token.
  if (!next.includes(SCHEMA_CHANGES_END_MARKER)) {
    if (next.includes(SCHEMA_CHANGES_MARKER)) {
      next = next.replace(SCHEMA_CHANGES_MARKER, block);
    } else {
      // No marker at all — append.
      next = `${next.trimEnd()}\n\n${block}\n`;
    }
  }
  return next;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
