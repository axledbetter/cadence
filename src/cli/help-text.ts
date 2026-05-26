/**
 * Two-level help grouping for the claude-autopilot CLI.
 *
 * The CLI ships ~25 subcommands. A flat list crowds the welcome screen and
 * makes it hard for new users to find the verb they need. This module owns
 * the canonical grouping (Pipeline / Review / Deploy / Migrate / Diagnostics
 * / Advanced), the per-verb summaries, and the per-verb Options blocks.
 *
 * The dispatcher in index.ts imports these helpers — keeping the data here
 * means the help text can be rendered into a string for tests without firing
 * the side-effecting top-level switch statement in index.ts.
 *
 * Group assignments are asserted by tests/cli/help-text.test.ts so newly
 * added verbs are forced into the structure rather than silently dropped.
 *
 * Groups are ordered roughly by user journey:
 *   Pipeline    — brainstorm → spec → plan → implement → PR
 *   Review      — operates on findings / runs the LLM-backed code review
 *   Deploy      — platform-specific deploy verbs
 *   Migrate     — database migration dispatch
 *   Diagnostics — sanity checks, second-opinion, test scaffolding
 *   Advanced    — long-running daemons / niche / experimental verbs
 */

export type HelpVerb = { verb: string; summary: string };
export type HelpGroup = { name: string; tagline: string; verbs: HelpVerb[] };

export const HELP_GROUPS: HelpGroup[] = [
  {
    name: 'Pipeline',
    tagline: 'spec → plan → implement → PR loop',
    verbs: [
      { verb: 'init', summary: 'Scaffold guardrail.config.yaml + auto-detect migrate stack (writes .autopilot/stack.md)' },
      { verb: 'setup', summary: 'Auto-detect stack, write config, install pre-push hook' },
      { verb: 'scaffold', summary: 'Scaffold project skeleton from a spec markdown (--from-spec <path> [--stack node|python|fastapi|go|rust])' },
      { verb: 'examples', summary: 'Print sample specs for each supported stack (use as starter templates for `scaffold --from-spec`)' },
      { verb: 'autopilot', summary: 'Multi-phase orchestrator — run scan → spec → plan → implement under one runId (v6.2.0)' },
      { verb: 'brainstorm', summary: 'Pipeline entry point (Claude Code skill — see /brainstorm)' },
      { verb: 'spec', summary: 'Spec-writing pointer (Claude Code skill — see /brainstorm)' },
      { verb: 'plan', summary: 'Pipeline plan phase (engine-wrap shell — see superpowers:writing-plans skill)' },
      { verb: 'implement', summary: 'Pipeline implement phase (engine-wrap shell — see claude-autopilot skill)' },
      { verb: 'review', summary: 'Pipeline review phase (engine-wrap shell — see /review, /review-2pass)' },
      { verb: 'validate', summary: 'Pipeline validate phase (engine-wrap shell — see /validate skill)' },
      { verb: 'pr', summary: 'Review a specific PR by number (auto-detects if on PR branch)' },
      { verb: 'pr-desc', summary: 'Generate a PR title / summary / test plan from the current diff' },
    ],
  },
  {
    name: 'Review',
    tagline: 'findings + scan + autofix',
    verbs: [
      { verb: 'run', summary: 'Review git-changed files (default)' },
      { verb: 'scan', summary: 'Review any path — no git required' },
      { verb: 'ci', summary: 'Opinionated CI entrypoint (post comments + SARIF)' },
      { verb: 'fix', summary: 'Auto-fix cached findings using the configured LLM' },
      { verb: 'baseline', summary: 'Manage the committed findings baseline (create|update|show|delete)' },
      { verb: 'triage', summary: 'Mark individual findings as accepted/dismissed' },
      { verb: 'explain', summary: 'Deep-dive explanation + remediation for a specific finding' },
      { verb: 'report', summary: 'Render cached findings as a markdown report' },
      { verb: 'costs', summary: 'Show per-run cost summary' },
    ],
  },
  {
    name: 'Deploy',
    tagline: 'platform-specific deploy',
    verbs: [
      { verb: 'deploy', summary: 'Deploy via configured adapter (vercel | fly | render | generic) — also: rollback, status' },
    ],
  },
  {
    name: 'Migrate',
    tagline: 'database migration dispatch',
    verbs: [
      { verb: 'migrate', summary: 'Run database migrations via the stack-aware dispatcher' },
      { verb: 'migrate-doctor', summary: 'Validate .autopilot/stack.md and skill manifests (alias: migrate doctor)' },
      { verb: 'migrate-v4', summary: 'Codemod for v4 → v5 repo migration (not a pipeline phase)' },
    ],
  },
  {
    name: 'Diagnostics',
    tagline: 'sanity checks + second-opinion + test scaffolding',
    verbs: [
      { verb: 'doctor', summary: 'Check prerequisites (alias: preflight)' },
      { verb: 'preflight', summary: 'Check prerequisites (alias: doctor)' },
      { verb: 'council', summary: 'Multi-model review — dispatch the diff to N models and synthesize consensus' },
      { verb: 'test-gen', summary: 'Detect uncovered exports and generate test cases using the LLM' },
    ],
  },
  {
    name: 'Engine',
    tagline: 'v6 run state engine — list, inspect, GC, resume',
    verbs: [
      { verb: 'runs', summary: 'Inspect run state: runs list | show <id> | watch <id> | resume <id> | gc | delete <id> | doctor' },
    ],
  },
  {
    name: 'Dashboard',
    tagline: 'hosted product — login, status, manual upload (v7.0 Phase 2.3)',
    verbs: [
      { verb: 'dashboard', summary: 'Manage hosted dashboard auth + uploads: dashboard {login,logout,status,upload <runId>}' },
    ],
  },
  {
    name: 'Advanced',
    tagline: 'server / experimental — hidden from welcome screen',
    verbs: [
      { verb: 'worker', summary: 'Persistent review daemon for multi-terminal parallel usage (start|stop|status)' },
      { verb: 'mcp', summary: 'MCP server for Claude / ChatGPT integration' },
      { verb: 'hook', summary: 'Install / remove the pre-push git hook' },
      { verb: 'watch', summary: 'Watch for file changes and re-run on each save' },
      { verb: 'autoregress', summary: 'Snapshot regression tests (run|diff|update|generate)' },
      { verb: 'lsp', summary: 'Language server — publishes findings as LSP diagnostics (stdin/stdout)' },
      { verb: 'ignore', summary: 'Interactively add findings to .guardrail-ignore' },
    ],
  },
];

/**
 * Per-verb Options blocks. Keyed by the verb that owns the block. Some verbs
 * have no documented flags (e.g. `costs`, `lsp`, `report`) and are absent here;
 * `claude-autopilot help <verb>` will show just the row in that case.
 */
export const HELP_OPTIONS: Record<string, string> = {
  run: `Options (run):
  --base <ref>         Git base ref for diff (default: HEAD~1)
  --config <path>      Path to config file (default: ./guardrail.config.yaml)
  --files <a,b,c>      Explicit comma-separated file list (skips git detection)
  --dry-run            Show what would run without executing
  --diff               Send git diff hunks instead of full files (~70% fewer tokens)
  --delta              Only report findings new since last run (suppress pre-existing)
  --inline-comments    Post per-line review comments on the PR diff
  --post-comments      Post/update a summary comment on the open PR
  --format <text|sarif>  Output format (default: text)
  --output <path>        Output file path (required with --format sarif)`,
  scan: `Options (scan):
  <path> [path...]     Files or directories to scan (or --all for entire codebase)
  --all                Scan entire codebase
  --ask <question>     Targeted question to inject into the LLM review prompt
  --focus <type>       security | logic | performance (default: all)
  --dry-run            List files that would be scanned without running
  --config <path>      Path to config file
  --engine             [v7.0 deprecated no-op] engine is always on; flag emits a warning`,
  pr: `Options (pr):
  <number>                   PR number to review (optional if on a PR branch)
  --no-post-comments         Skip posting/updating PR summary comment
  --no-inline-comments       Skip posting per-line inline annotations
  --config <path>            Path to config file
  --engine                   [v7.0 deprecated no-op] engine is always on; flag emits a warning

  Note: pr is side-effecting — it posts/updates a PR comment and inline
        review comments via the gh CLI. Engine-on records a github-pr
        externalRef; future replays gate on the spec's "side-effect
        readback" rule (--force-replay required if a prior phase.success
        exists for the same run).`,
  fix: `Options (fix):
  --severity <critical|warning|all>  Which findings to fix (default: critical)
  --dry-run                          Preview fixes without writing files
  --config <path>                    Path to config file
  --engine                           [v7.0 deprecated no-op] engine is always on; flag emits a warning`,
  costs: `Options (costs):
  --config <path>      Path to config file
  --engine             [v7.0 deprecated no-op] engine is always on; flag emits a warning`,
  brainstorm: `Options (brainstorm):
  --config <path>      Path to config file
  --engine             [v7.0 deprecated no-op] engine is always on; flag emits a warning
  --json               Emit a structured JSON envelope on stdout

  Note: brainstorm is primarily a Claude Code skill (/brainstorm). The CLI
        verb is an advisory pointer; engine-on still produces a run-state
        snapshot (state.json + events.ndjson) for pipeline introspection.`,
  spec: `Options (spec):
  --config <path>      Path to config file
  --engine             [v7.0 deprecated no-op] engine is always on; flag emits a warning
  --json               Emit a structured JSON envelope on stdout

  Note: spec is primarily a Claude Code skill (entered via /brainstorm). The
        CLI verb is an advisory pointer; engine-on still produces a run-state
        snapshot (state.json + events.ndjson) for pipeline introspection.`,
  plan: `Options (plan):
  --spec <path>        Spec file the planner should read (optional)
  --output <path>      Where to write the plan markdown (default: .guardrail-cache/plans/<ts>-plan.md)
  --config <path>      Path to config file
  --engine             [v7.0 deprecated no-op] engine is always on; flag emits a warning`,
  review: `Options (review):
  --context <text>     Optional context note injected into the review log
  --output <path>      Where to write the review log (default: .guardrail-cache/reviews/<ts>-review.md)
  --config <path>      Path to config file
  --engine             [v7.0 deprecated no-op] engine is always on; flag emits a warning`,
  validate: `Options (validate):
  --context <text>     Optional context note injected into the validate log
  --output <path>      Where to write the validate log (default: .guardrail-cache/validate/<ts>-validate.md)
  --config <path>      Path to config file
  --engine             [v7.0 deprecated no-op] engine is always on; flag emits a warning

  Note: validate is primarily a Claude Code skill (/validate). The CLI verb
        is an engine-wrap shell; engine-on still produces a run-state
        snapshot (state.json + events.ndjson) for pipeline introspection.
        SARIF emission lives in \`claude-autopilot run --format sarif\`.`,
  autopilot: `Options (autopilot):
  --mode <full>        Pipeline mode (v6.2.0 ships 'full' only — scan → spec → plan → implement)
  --phases <a,b,c>     Explicit phase list (comma-separated; overrides --mode)
  --budget <usd>       Run-scope budget cap (USD). Cross-phase — actualSoFar accumulates across phases.
  --engine             [v7.0 deprecated no-op] engine is always on; flag emits a warning

  Behavior: drives N pipeline phases under ONE runId so a \`runs watch <id>\`
            window covers the whole pipeline. Sequential — no parallel
            execution. Non-interactive — pause budget decisions hard-fail.
            Exit codes: 0 success, 78 budget_exceeded, 2 engine error
            (lock_held / corrupted_state / partial_write), 1 everything else.
            Resume a failed pipeline via \`claude-autopilot run resume <id>\`.

  v6.2.0 ships scan / spec / plan / implement only. \`migrate\` and \`pr\`
  land in v6.2.1 once their per-phase idempotency contracts (preflight
  readback + externalRef recorded BEFORE side-effect) are wired. The
  --mode=fix and --mode=review modes land in v6.2.1+; --json envelope
  lands in v6.2.2.

  Examples:
    claude-autopilot autopilot
    claude-autopilot autopilot --budget 25
    claude-autopilot autopilot --phases=scan,spec,plan`,
  examples: `Options (examples):
  [<stack>]            Optional: print only the spec for one stack (node|python|fastapi|go|rust)
                       With no arg, lists all supported stacks with a 5-line preview each.

  Behavior: read-only. Reads bundled spec files from the package's
            \`examples/specs/\` directory and prints them to stdout. Pipe
            to a file to use as a starter template:

              claude-autopilot examples node > docs/specs/my-feature.md
              claude-autopilot scaffold --from-spec docs/specs/my-feature.md

  Exit codes: 0 success, 1 unknown stack id or missing bundled file.`,
  dashboard: `Options (dashboard):
  login                Open browser, mint API key via loopback callback
  logout               Revoke server-side, delete local config
  status               Show login state + memberships + last upload
  upload <runId>       Manually upload a run (resume an interrupted auto-upload)

  Auto-upload: after \`dashboard login\`, every engine-on autopilot run
  uploads to autopilot.dev when run.complete fires. Failure prints a
  resume command and never fails the run. Opt out per-run with
  \`--no-upload\` or globally with \`CLAUDE_AUTOPILOT_UPLOAD=off\`.

  Env:
    AUTOPILOT_DASHBOARD_BASE_URL   Override base URL (default https://autopilot.dev)
    CLAUDE_AUTOPILOT_HOME          Override config dir (default ~/.claude-autopilot)
    CLAUDE_AUTOPILOT_UPLOAD=off    Skip auto-upload at run.complete

  Examples:
    claude-autopilot dashboard login
    claude-autopilot dashboard status
    claude-autopilot dashboard upload 01HFGB...`,
  implement: `Options (implement):
  --context <text>     Optional context note injected into the implement log
  --plan <path>        Plan file the implement phase consumed (e.g. docs/plans/<slug>.md)
  --output <path>      Where to write the implement log (default: .guardrail-cache/implement/<ts>-implement.md)
  --config <path>      Path to config file
  --engine             [v7.0 deprecated no-op] engine is always on; flag emits a warning

  Note: implement is primarily a Claude Code skill (claude-autopilot — reads
        plan, dispatches subagents per plan phase via subagent-driven-development,
        writes code, runs tests, commits, optionally pushes via commit-push-pr).
        The CLI verb is an engine-wrap shell; engine-on still produces a
        run-state snapshot (state.json + events.ndjson) for pipeline
        introspection. The v6.0.7 wrap declares idempotent: true,
        hasSideEffects: false because the CLI verb writes a local log stub
        only — no git push, no PR creation. If a future PR inlines the
        implement loop into the CLI verb, the declarations flip to match
        the spec table (idempotent: false, hasSideEffects: true,
        externalRefs: git-remote-push). See src/cli/implement.ts deviation
        note for the full rationale.`,
  watch: `Options (watch):
  --config <path>      Path to config file (default: ./guardrail.config.yaml)
  --debounce <ms>      Debounce delay in ms (default: 300)`,
  autoregress: `Options (autoregress):
  --all                    Run/diff all snapshots
  --since <ref>            Git ref for changed-files detection
  --snapshot <slug>        Target a single snapshot
  --files <a,b,c>          Explicit file list for generate (skips git detection)`,
  migrate: `Options (migrate):
  --env <name>         Target environment from .autopilot/stack.md (default: dev)
  --dry-run            Run skill in dry-run mode (no side effects)
  --yes                Required to apply prod migrations in CI
  --config <path>      Path to config file (default: ./guardrail.config.yaml)
  --engine             [v7.0 deprecated no-op] engine is always on; flag emits a warning

  Note: migrate is a side-effecting phase — re-running with --engine after a
        prior phase.success requires --force-replay (Phase 6+) because the
        engine cannot read back \`migration_state\` yet. Each applied
        migration emits a \`migration-version\` externalRef under the run
        for the resume gate.`,
  'migrate-doctor': `Options (migrate doctor / migrate-doctor):
  --fix                Apply auto-fixable mutations (legacy stack.md, skills/migrate/, schema_version)`,
  runs: `Sub-verbs (runs):
  runs list                              List runs newest-first
  runs show <id>                         Show a run's state + last events
  runs watch <id>                        Tail events.ndjson with a live cost meter
  runs gc                                Delete completed runs older than N days
  runs delete <id>                       Delete a single run (terminal-status only)
  runs doctor                            Replay events vs. state.json; report drift
  run resume <id>                        Lookup-only: identify the next phase + decision

Options (runs list):
  --status <s>         Filter: pending | running | paused | completed | failed | aborted
  --json               Emit a structured JSON envelope on stdout

Options (runs show):
  <id>                 ULID of the run to inspect
  --events             Tail events.ndjson after the state summary
  --events-tail <n>    How many tail events to show (default 20)
  --json               Emit a structured JSON envelope on stdout

Options (runs watch):
  <id>                 ULID of the run to watch
  --since <seq>        Replay forward from a specific event seq (resume after disconnect)
  --no-follow          Render the current state once and exit (snapshot mode)
  --json               Emit raw NDJSON to stdout (one event per line) — ANSI suppressed
  --no-color           Force ANSI off even on a TTY

  Behavior: tails events.ndjson via fs.watchFile (1s poll) and pretty-renders
            each new event with a running cost/budget meter. Exits when the
            run terminates (run.complete / run.failed / run.aborted) or on
            Ctrl-C. Exit codes: 0 success, 1 invalid input or stream error,
            2 not_found.

Options (runs gc):
  --older-than-days <n>  Cutoff in days (default 30)
  --dry-run              Preview deletions without touching disk
  --yes                  Skip the confirmation prompt
  --json                 Emit a structured JSON envelope on stdout

Options (runs delete):
  <id>                 ULID of the run to delete
  --force              Override the terminal-status guard (dangerous)
  --json               Emit a structured JSON envelope on stdout

Options (runs doctor):
  <id>                 Limit the check to a single run id (optional)
  --fix                Rewrite state.json from events.ndjson where drift is found
  --json               Emit a structured JSON envelope on stdout

Options (run resume):
  <id>                 ULID of the run to look up
  --from-phase <name>  Resume target phase by name (must exist on the run)
  --json               Emit a structured JSON envelope on stdout

  NOTE: \`run resume\` in v6 Phase 3 is LOOKUP-ONLY. It identifies which phase
        would resume from and the decision rationale (retry, skip-idempotent,
        needs-human, already-complete) without actually executing the phase.
        Real execution wires in v6 Phase 6+.`,
  deploy: `Options (deploy):
  --adapter <vercel|fly|render|generic>   Override deploy.adapter from config
  --config <path>              Path to config file
  --ref <ref>                  Git ref (branch / tag) to deploy
  --sha <commit>               Specific commit SHA to deploy
  --watch                      Stream build logs to stderr in real time (vercel: SSE; fly: WebSocket; render: REST polling)
  --to <deploy-id>             Target deploy ID for 'deploy rollback'
  --pr <n>                     Post upserting deploy summary comment on the PR

Subcommands (deploy):
  deploy                       Deploy via configured adapter
  deploy rollback              Roll back to previous prod deploy
  deploy rollback --to <id>    Roll back to a specific deploy
  deploy status                Show current prod + last 5 builds`,
};

/** Pad the verb column so summaries align across groups. */
function padVerb(verb: string): string {
  const WIDTH = 16;
  return verb.length >= WIDTH ? verb + ' ' : verb + ' '.repeat(WIDTH - verb.length);
}

/**
 * Documentation block for the v7.11.0+ `concurrency:` configuration in
 * `guardrail.config.yaml`. Rendered by `claude-autopilot help concurrency`
 * (advisory pointer — there is no `concurrency` verb; this is config docs).
 *
 * Keep this block in sync with:
 *   - `presets/schemas/guardrail.config.schema.json` (the validated shape)
 *   - `skills/autopilot/SKILL.md` Step 3 (the fallback rule consumer)
 *   - `skills/writing-plans/SKILL.md` (`depends_on:` annotation contract)
 *   - `src/core/concurrent-dispatch/dep-graph.ts` (`DEFAULT_FALLBACK_POLICY`)
 */
export const CONCURRENCY_CONFIG_BLOCK = `guardrail.config.yaml — concurrency block (v7.11.0+):

  concurrency:
    maxParallelSubagents: 3              # int, range 1..8, default 3
    perSubagentTimeoutMs: 1800000        # int ms, default 30 min (1,800,000)
    assumeIndependentWithoutDependsOn: false  # bool, default false
    useDedicatedMergeWorktree: true      # bool, default true
    allowMergeCommitsInTasks: false      # bool, default false

  budgets:
    perRunUSD: 10                        # number USD, existing
    perPhaseUSD: 5                       # number USD, existing
    perSubagentUSD: 3                    # number USD or null (v7.11.0+)
                                         #   HARD cap per subagent: dispatch
                                         #   is rejected if preflight estimate
                                         #   exceeds it; an in-flight subagent
                                         #   is SIGTERMed if actual cost
                                         #   exceeds it. Set null to disable.

Keys:

  maxParallelSubagents
    Maximum concurrent subagents. Schema range 1..8 (enforced at config-load
    via presets/schemas/guardrail.config.schema.json — invalid values fail).
    Effective concurrency at runtime is further clamped by
    providerRateLimitConcurrency and the remaining task count. Setting to 1
    reproduces v7.10.0 sequential behavior exactly.

  perSubagentTimeoutMs
    Hard per-subagent timeout. On expiry the scheduler SIGTERMs the
    subagent's entire process group (kill -TERM -<pgid>); SIGKILL follows
    after 30s if no response. Emits both task.timeout (informational) and
    task.failed (terminal, error_type: 'timeout') events.

  assumeIndependentWithoutDependsOn
    Fallback policy for plans where ZERO tasks declare depends_on. Default
    false = run sequentially (preserves v7.10.0 semantics). Set true to opt
    in to file-overlap inference for unannotated plans. Has no effect when
    at least one task in the plan declares depends_on.

  useDedicatedMergeWorktree
    When true (default), the merge orchestrator cherry-picks task branches
    inside a dedicated integration worktree at
    .claude/worktrees/<run-ulid>/integration/ — the main repo working tree
    is never touched. Disable only if your repo cannot afford the extra
    worktree (rarely necessary).

  allowMergeCommitsInTasks
    When false (default), the merge orchestrator rejects task branches that
    contain merge commits. Subagents are expected to produce a linear
    sequence of commits on top of base_sha.

  budgets.perSubagentUSD
    HARD per-subagent cost cap. Dispatch is rejected when preFlightEstimate
    > perSubagentUSD. An in-flight subagent is killed and emits task.failed
    with error_type: 'budget_exceeded' if actual_cost_usd exceeds the cap
    mid-run. Set to null to disable the per-subagent cap entirely (in which
    case only the perRunUSD soft reservation applies).

Fallback rule (single source of truth — enforced in
src/core/concurrent-dispatch/dep-graph.ts):

  1. concurrency.maxParallelSubagents: 1 → sequential dispatch.
  2. ZERO tasks declare depends_on → sequential, unless
     assumeIndependentWithoutDependsOn: true.
  3. At least one task declares depends_on → use explicit deps + file-
     overlap inference for unannotated tasks.

See skills/writing-plans/SKILL.md for the depends_on annotation contract.`;

/**
 * Global flags advertised in --help. These work across most verbs (per-verb
 * support varies; v6.0.1 wires them into `scan` first, additional verbs land
 * in subsequent v6.0.x point releases per docs/v6/wrapping-pipeline-phases.md).
 */
export const GLOBAL_FLAGS_BLOCK = `Global flags:
  --json                 Emit a structured JSON envelope on stdout (most verbs)
  --engine               [v7.0 deprecated no-op] engine is always on; flag emits a warning
                         v7.0 removed the engine-off opt-out flag and code path entirely.
                         CLAUDE_AUTOPILOT_ENGINE=off is now ignored (warns once per process)
                         instead of disabling the engine. See docs/v7/breaking-changes.md.

Resolution overrides (v7.8.0):
  --tsx-source <bundled|project|path>
                         Override how the dev launcher picks the tsx binary used
                         to run .ts files. Default precedence is project-local
                         → PATH → bundled (with deprecation warning on the
                         bundled fallthrough). Env equivalent: CLAUDE_AUTOPILOT_TSX.
                         Silence the bundled-fallthrough warning with
                         CLAUDE_AUTOPILOT_NO_TSX_DEPRECATION=1. \`tsx\` will be
                         removed from runtime deps in v8.0.0.

User-type profile (v8.2.0+, full CLI wiring lands in v8.2.0 PR2):
  --profile <name>       Override the active user-type profile (solo, small-team,
                         oss-maintainer, enterprise, learning). Precedence:
                         .autopilot/profile < CLAUDE_AUTOPILOT_PROFILE env < this flag.
                         Default is solo (behavioral parity with v7.10.1).
                         Schema + resolver shipped in v8.2.0 PR1; the flag
                         becomes active once dispatcher wiring lands in PR2.`;

/** Build the full two-level help text. Returned as a string so tests can assert against it without spawning. */
export function buildHelpText(): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('Usage: claude-autopilot <command> [options]  (legacy alias: guardrail)');
  lines.push('');
  for (const group of HELP_GROUPS) {
    lines.push(`\x1b[1m${group.name}:\x1b[0m  \x1b[2m# ${group.tagline}\x1b[0m`);
    for (const v of group.verbs) {
      lines.push(`  ${padVerb(v.verb)}${v.summary}`);
    }
    lines.push('');
  }
  lines.push(GLOBAL_FLAGS_BLOCK);
  lines.push('');
  for (const group of HELP_GROUPS) {
    for (const v of group.verbs) {
      const block = HELP_OPTIONS[v.verb];
      if (block) {
        lines.push(block);
        lines.push('');
      }
    }
  }
  lines.push(CONCURRENCY_CONFIG_BLOCK);
  lines.push('');
  lines.push('Run \x1b[36mclaude-autopilot help <command>\x1b[0m for command-specific options.');
  return lines.join('\n') + '\n';
}

/** Build help text for a single verb. Returns null if the verb is unknown. */
export function buildCommandHelpText(verb: string): string | null {
  for (const group of HELP_GROUPS) {
    const match = group.verbs.find(v => v.verb === verb);
    if (match) {
      const lines: string[] = [];
      lines.push('');
      lines.push(`Usage: claude-autopilot ${verb} [options]`);
      lines.push('');
      lines.push(`  ${padVerb(match.verb)}${match.summary}`);
      lines.push(`  \x1b[2m(group: ${group.name} — ${group.tagline})\x1b[0m`);
      lines.push('');
      const block = HELP_OPTIONS[verb];
      if (block) {
        lines.push(block);
        lines.push('');
      }
      return lines.join('\n');
    }
  }
  return null;
}

/** Set of verbs that have a row in HELP_GROUPS — used by `help <verb>` lookup and by tests. */
export const HELP_VERBS: readonly string[] = HELP_GROUPS.flatMap(g => g.verbs.map(v => v.verb));
