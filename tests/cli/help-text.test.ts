import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildHelpText,
  buildCommandHelpText,
  HELP_VERBS,
} from '../../src/cli/help-text.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = path.join(ROOT, 'src', 'cli', 'index.ts');

function runCli(args: string[]): { stdout: string; stderr: string; code: number } {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', ENTRY, ...args],
    {
      cwd: ROOT,
      env: { ...process.env, ANTHROPIC_API_KEY: 'test-key' },
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? 1,
  };
}

const REQUIRED_GROUP_HEADINGS = [
  'Pipeline:',
  'Review:',
  'Deploy:',
  'Migrate:',
  'Diagnostics:',
  'Advanced:',
];

describe('two-level help text', () => {
  it('HT1: full help contains every group heading', () => {
    const out = buildHelpText();
    for (const heading of REQUIRED_GROUP_HEADINGS) {
      assert.ok(
        out.includes(heading),
        `full help is missing required group heading "${heading}". Got:\n${out}`,
      );
    }
  });

  it('HT2: every documented verb appears under exactly one group', () => {
    // HELP_VERBS is built by flat-mapping HELP_GROUPS, so duplicates would
    // surface as a length mismatch with the deduped Set. This assertion locks
    // the invariant in case a verb gets added to two groups by accident.
    const set = new Set(HELP_VERBS);
    assert.equal(
      set.size,
      HELP_VERBS.length,
      `HELP_VERBS has duplicates — every verb must appear under exactly one group. Got: ${HELP_VERBS.join(', ')}`,
    );
  });

  it('HT3: the documented top-level subcommands are all routed', () => {
    // Cross-check against SUBCOMMANDS-style coverage: every verb shown in the
    // grouped help must dispatch (i.e. `claude-autopilot <verb> --help` does
    // not print "Unknown subcommand"). This catches the "advertised but not
    // wired" regression that bit the welcome screen in alpha.3.
    for (const verb of HELP_VERBS) {
      const r = runCli([verb, '--help']);
      const combined = r.stdout + r.stderr;
      assert.ok(
        !new RegExp(`Unknown subcommand: "${verb}"`, 'i').test(combined),
        `help advertises \`${verb}\` but dispatcher rejects it.\nOutput head:\n${combined.slice(0, 400)}`,
      );
    }
  });

  it('HT4: `--help` flag prints all six group headings', () => {
    const r = runCli(['--help']);
    assert.equal(r.code, 0);
    for (const heading of REQUIRED_GROUP_HEADINGS) {
      assert.ok(
        r.stdout.includes(heading),
        `--help is missing required group heading "${heading}".\nstdout head:\n${r.stdout.slice(0, 400)}`,
      );
    }
  });

  it('HT5: `help deploy` prints just the deploy section + its Options block', () => {
    const focused = buildCommandHelpText('deploy');
    assert.ok(focused !== null, 'buildCommandHelpText("deploy") returned null');
    // Must include the verb summary row…
    assert.ok(focused!.includes('deploy'), 'focused help missing the verb');
    // …and the deploy Options block…
    assert.ok(focused!.includes('Options (deploy):'), 'focused help missing Options (deploy):');
    assert.ok(focused!.includes('--adapter'), 'focused help missing --adapter flag');
    assert.ok(focused!.includes('Subcommands (deploy):'), 'focused help missing Subcommands (deploy):');
    // …but NOT every other group heading. We look for "Pipeline:" specifically
    // because the deploy block legitimately mentions "Deploy" and "Migrate"
    // (in the alias hint).
    assert.ok(
      !focused!.includes('Pipeline:'),
      `focused help leaked the Pipeline group heading — should be deploy-only.\nGot:\n${focused}`,
    );
    assert.ok(
      !focused!.includes('Review:'),
      `focused help leaked the Review group heading — should be deploy-only.\nGot:\n${focused}`,
    );
  });

  it('HT6: `help <unknown>` exits 1 with an "unknown command" message', () => {
    const r = runCli(['help', 'totallymadeupverb']);
    assert.equal(r.code, 1, `expected exit 1 for unknown verb, got ${r.code}\nstderr:\n${r.stderr}`);
    const combined = r.stdout + r.stderr;
    assert.ok(
      /unknown command/i.test(combined),
      `expected "unknown command" message, got:\n${combined.slice(0, 400)}`,
    );
    // Falls back to full help — verify by sampling one heading.
    assert.ok(
      combined.includes('Pipeline:'),
      `expected fallback full help when verb is unknown, got:\n${combined.slice(0, 400)}`,
    );
  });

  it('HT7: `help deploy` invoked through the CLI prints the deploy block', () => {
    // End-to-end check that the dispatch case actually wires buildCommandHelpText.
    const r = runCli(['help', 'deploy']);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}. stderr:\n${r.stderr}`);
    assert.ok(
      r.stdout.includes('Options (deploy):'),
      `CLI \`help deploy\` did not include the deploy Options block.\nstdout head:\n${r.stdout.slice(0, 400)}`,
    );
    assert.ok(
      !r.stdout.includes('Pipeline:'),
      `CLI \`help deploy\` leaked the Pipeline group — should be focused.\nstdout head:\n${r.stdout.slice(0, 400)}`,
    );
  });

  it('HT8: help council prints the council Options block with all documented flags', () => {
    // Regression guard for issue #29 (LOW finding) — council was added to
    // HELP_GROUPS but had no HELP_OPTIONS entry, so `cadence help council`
    // showed zero flag-level help. This locks in the populated block + the
    // stable section anchors (Behavior/Exit codes/Examples) so accidental
    // truncation in a future edit still trips the test.
    const focused = buildCommandHelpText('council');
    assert.ok(focused !== null, 'buildCommandHelpText("council") returned null');
    assert.ok(focused!.includes('Options (council):'), 'focused help missing Options (council):');
    for (const flag of ['--prompt', '--context-file', '--config', '--dry-run', '--no-synthesize', '--json']) {
      assert.ok(focused!.includes(flag), `focused help missing ${flag} flag`);
    }
    for (const anchor of ['Behavior:', 'Exit codes:', 'Examples:']) {
      assert.ok(focused!.includes(anchor), `focused help missing ${anchor} section`);
    }
  });

  it('HT9: `help council` invoked through the CLI prints the council Options block', () => {
    // End-to-end mirror of HT7 — guarantees the dispatch case wires
    // buildCommandHelpText for the council verb, not just the helper.
    const r = runCli(['help', 'council']);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}. stderr:\n${r.stderr}`);
    assert.ok(
      r.stdout.includes('Options (council):'),
      `CLI \`help council\` did not include the council Options block.\nstdout head:\n${r.stdout.slice(0, 400)}`,
    );
  });
});
