# Plan — Issue #29: council help text

**Spec:** `docs/superpowers/specs/2026-05-26-issue-29-council-dedup-design.md`  
**Branch:** `feat/issue-29-council-dedup`  
**Risk tier:** Low (1 codex PR pass)

## Context summary

The MED dedup bug from issue #29 was already fixed by PR #42 (commit `bf33ca8`, merged 2026-05-04). Verified: `src/core/council/runner.ts` only includes `responseSections` in `synthesisPrompt`, and `tests/council/runner.test.ts` R8 regression test passes. Issue #29 is still open because the LOW finding — `printUsage()` missing `council` — has only been partially addressed: `council` appears in `HELP_GROUPS` but has no `HELP_OPTIONS` block, so `cadence help council` shows zero flag docs.

## Task list (single subagent dispatch)

### Task 1 — Add `HELP_OPTIONS['council']` block

**File:** `src/cli/help-text.ts`

Insert a new key `council` in the `HELP_OPTIONS` record between `'migrate-doctor'` and `runs` (matches reading order in `HELP_GROUPS`).

Content (exact, copy from spec §1):

```ts
council: `Options (council):
  --prompt <text>          Question for the council to deliberate on (required unless --dry-run)
  --context-file <path>    File whose contents form the shared conversation context (required unless --dry-run)
  --config <path>          Path to config file (default: ./guardrail.config.yaml)
  --dry-run                Print the resolved council config as JSON and exit (no model calls)
  --no-synthesize          Run advisors but skip the synthesizer call (stub returns empty text)
  --json                   Wrap stdout in the standard envelope (\`{ command: "council", ... }\`)

  Behavior: dispatches the prompt + context to N advisor models declared in
            \`council.models\` (guardrail.config.yaml), then forwards the
            structured advisor responses to the synthesizer declared in
            \`council.synthesizer\`. Stdout is always the JSON result envelope
            (schema_version, run_id, status, per-advisor responses, optional
            synthesis); \`--json\` additionally wraps it in the standard CLI
            command envelope used by other verbs. Run cost is recorded so
            \`cadence costs\` reflects council runs.

  Exit codes: 0 success; 1 partial (synthesizer failed but advisors succeeded);
              2 failed (fewer than \`council.minSuccessfulResponses\`
              advisors succeeded); 1 also for config-load / IO / argument
              errors that abort before dispatch.

  Examples:
    cadence council --dry-run
    cadence council --prompt "Should we use X or Y?" --context-file ./design.md
    cadence council --prompt "..." --context-file ./ctx.md --no-synthesize --json`,
```

### Task 2 — Add HT8 regression test

**File:** `tests/cli/help-text.test.ts`

Append a new `it()` inside the existing `describe('two-level help text', ...)` block:

```ts
it('HT8: help council prints the council Options block with all documented flags', () => {
  const focused = buildCommandHelpText('council');
  assert.ok(focused !== null, 'buildCommandHelpText("council") returned null');
  assert.ok(focused!.includes('Options (council):'), 'focused help missing Options (council):');
  for (const flag of ['--prompt', '--context-file', '--config', '--dry-run', '--no-synthesize', '--json']) {
    assert.ok(focused!.includes(flag), `focused help missing ${flag} flag`);
  }
  // Stable anchors — if any of these sections gets dropped in a future edit,
  // the test catches it without snapshotting the full block text.
  for (const anchor of ['Behavior:', 'Exit codes:', 'Examples:']) {
    assert.ok(focused!.includes(anchor), `focused help missing ${anchor} section`);
  }
});

it('HT9: cadence help council via CLI prints the council Options block', () => {
  // End-to-end check that the dispatch case actually wires buildCommandHelpText
  // for the council verb (mirrors HT7 for deploy).
  const r = runCli(['help', 'council']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}. stderr:\n${r.stderr}`);
  assert.ok(
    r.stdout.includes('Options (council):'),
    `CLI \`help council\` did not include the council Options block.\nstdout head:\n${r.stdout.slice(0, 400)}`,
  );
});
```

### Task 3 — Verify

1. `npm test -- tests/cli/help-text.test.ts` — all HT1..HT8 must pass.
2. `npm test` (full suite) — baseline ~2155+ tests must remain green; no regressions.
3. Manual: `node --import tsx/esm src/cli/index.ts help council` — eyeball that the Options block surfaces.

## Out of scope

- Any change to `src/core/council/runner.ts`, `src/cli/council.ts`, or `src/adapters/council/*`.
- Version bump in `package.json` (coordinator handles).
- CHANGELOG entry (small fix, will be folded into the next coordinator-managed release notes).

## Acceptance criteria

- `tests/cli/help-text.test.ts` HT8 added and passing.
- Full test suite green.
- `cadence help council` shows a populated Options block listing all six flags.
- No changes outside `src/cli/help-text.ts`, `tests/cli/help-text.test.ts`, and the spec/plan docs.
