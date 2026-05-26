# Issue #29 — Council synthesizer prompt dedup + missing help text

**Status:** spec  
**Risk tier:** Low (1 codex pass per policy)  
**Owner:** axledbetter  
**Date:** 2026-05-26  
**Closes:** axledbetter/cadence#29

## Problem

Issue #29 raised two bugbot findings on PR #25 (council CLI feature) that were not fixed before merge (3-round triage cap hit):

1. **MED — Advisor responses duplicated in synthesizer input.** `responseSections` was included in both `synthesisDoc` (windowed via `synthesisInputMaxTokens`) AND `synthesisPrompt`. The adapter concatenates both into one LLM message, so advisor responses were sent twice — and `synthesisPrompt` was not subject to windowing, so the real input could blow past the configured budget.

2. **LOW — `printUsage()` missing `council` entry.** `council` was added to `SUBCOMMANDS` and the dispatch switch but never listed in the user-facing help.

## Current state (master @ 34e0bd8)

A pre-existing PR #42 (commit `bf33ca8`, merged 2026-05-04) already fixed the **MED dedup finding** in `src/core/council/runner.ts`. Verification:

- `runner.ts` now builds `synthesisPrompt` with `responseSections` as the single source of truth and feeds the synthesizer `synthesisCtx = windowContext(contextDoc, synthesisInputMaxTokens)` — i.e. the original conversation doc, not a mash-up.
- Regression test `tests/council/runner.test.ts` "R8: synthesizer receives advisor responses exactly once" asserts each response marker appears exactly once across `prompt + context`.

The **LOW help-text finding** is partially addressed:

- `council` IS listed in `HELP_GROUPS` under "Diagnostics" with a one-line summary in `src/cli/help-text.ts` (line 86).
- `council` IS NOT in `HELP_OPTIONS` — so `cadence help council` prints the verb summary but ZERO flag documentation. Compared with every other diagnostic verb (`doctor` has a block via `HELP_OPTIONS`; sibling verbs like `pr`, `scan`, `validate` all have flag tables), the user discovering the verb has no path to learn how to invoke it.

Issue #29 was never closed because the help-text follow-up was lost.

## Scope

Single, targeted change:

- **Add `HELP_OPTIONS['council']`** in `src/cli/help-text.ts` documenting the council verb's flags (`--prompt`, `--context-file`, `--config`, `--dry-run`, `--no-synthesize`, `--json`) plus a short usage note + example.
- **No runtime changes.** The dedup fix is already merged and tested; nothing else in `runner.ts`, `council.ts`, or adapters needs to move.
- **No version bump** — coordinator handles that at merge time per the PR brief.

## Non-goals

- Re-architecting `runCouncil()` or the synthesizer prompt format.
- Touching adapters (`claude.ts`, `openai.ts`).
- Adding new CLI flags. The CLI surface is frozen as-shipped in PR #25.
- Documenting `council` outside the help table (README/CHANGELOG churn). The `Closes #29` PR body is sufficient.

## Implementation

### 1. `src/cli/help-text.ts` — add to `HELP_OPTIONS`

Insert a new key `council` alongside other diagnostic verbs (alphabetical-ish, between `'migrate-doctor'` and `runs`):

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

### 2. Test coverage

`tests/cli/help-text.test.ts` already has `HT3` that exercises `<verb> --help` for every verb in `HELP_VERBS`. Add one focused assertion to verify the `council` Options block surfaces:

```ts
it('HT8: help council prints the council Options block with all documented flags', () => {
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

it('HT9: cadence help council via CLI prints the council Options block', () => {
  const r = runCli(['help', 'council']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}. stderr:\n${r.stderr}`);
  assert.ok(r.stdout.includes('Options (council):'),
    `CLI \`help council\` did not include the council Options block.\nstdout head:\n${r.stdout.slice(0, 400)}`);
});
```

### 3. Runtime smoke

Manual: invoke the CLI via the local entry point and verify the Options block surfaces, e.g. `node --import tsx/esm src/cli/index.ts help council`. Anywhere `cadence` is installed (post-publish), `cadence help council` is equivalent.

## Risk + rollback

- **Risk: Low.** Pure doc string in an exported constant. No runtime branches touched.
- **Rollback:** revert the single commit.
- **Blast radius:** nil — only `cadence help council` output changes.

## Test plan

- `npm test` — the existing 2155+ suite must remain green; the new HT8 assertion adds one.
- Manual: invoke `cadence help council` (via tsx in the worktree) and eyeball the output is well-formed.

## Codex follow-ups appendix

Codex review (gpt-5.5, 2026-05-26):

- **WARNING — test does not cover all documented flags.** Resolved inline: HT8 now iterates over `['--prompt', '--context-file', '--config', '--dry-run', '--no-synthesize', '--json']`.
- **WARNING — `--json` wording was ambiguous about default output.** Resolved inline: clarified that stdout is always the JSON result envelope; `--json` adds the standard CLI command-envelope wrapper.
- **WARNING — exit-code documentation could be wrong.** Verified against `src/cli/council.ts:107-109`: `failed → 2`, `partial → 1`, default 0; pre-dispatch IO/config errors return 1 too. Help block now states this exactly.
- **NOTE — help block may drift if council internals churn.** Acknowledged. Kept the user-facing surface and dropped the `appendCostLog` mention in favor of the stable phrasing "Run cost is recorded so `cadence costs` reflects council runs."
- **NOTE — smoke command should match project convention.** Acknowledged; left the `node --import tsx/esm` invocation since the repo does not ship an `npm run cli` shortcut, but called out `cadence help council` as the user-facing equivalent.
