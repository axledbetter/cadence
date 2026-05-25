import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_DIR = path.join(ROOT, 'src', 'cli');

// Files where `[guardrail]` is the right thing to keep, intentionally.
// Any match elsewhere fails the test — prevents silent regressions as new errors
// are added with the old prefix during the v4→v5 transition.
const ALLOWED_FILES = new Set<string>([
  // legacy bin wrapper emits the deprecation notice that literally contains the
  // word "guardrail" to name the CLI being deprecated — fine
  'bin/guardrail.js',
  'bin/_launcher.js',
  // top-level CLI help text references "guardrail" as the legacy bin name in
  // backtick code samples (e.g. `guardrail run`) — those are migration hints
  // not error prefixes
]);

// Match `[guardrail]` AND `[guardrail <phase>]` (e.g. `[guardrail baseline]`,
// `[guardrail costs]`). The phase variants were missed by the original
// `/\[guardrail\]/` regex, letting legacy prefixes leak past the audit.
const PREFIX_RE = /\[guardrail(?: [\w-]+)?\]/;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(path.join(dir, entry.name), acc);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

describe('error prefix hygiene', () => {
  it('src/cli/** uses [cadence] or [claude-autopilot] prefix, not legacy [guardrail]', () => {
    const files = walk(CLI_DIR);
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const relFile = path.relative(ROOT, file);
      if (ALLOWED_FILES.has(relFile)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (PREFIX_RE.test(line)) {
          offenders.push({ file: relFile, line: i + 1, text: line.trim().slice(0, 120) });
        }
      });
    }
    if (offenders.length > 0) {
      const report = offenders.map(o => `  ${o.file}:${o.line}  ${o.text}`).join('\n');
      assert.fail(
        `Found ${offenders.length} [guardrail] prefix(es) in src/cli/. ` +
        `Replace with [cadence] (preferred) / [claude-autopilot] or the phase name (e.g. [run], [doctor]).\n${report}\n\n` +
        `If a match is legitimate (e.g. discussing the legacy bin by name), add the file to ALLOWED_FILES in this test.`,
      );
    }
  });
});
