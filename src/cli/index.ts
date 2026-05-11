#!/usr/bin/env node
/**
 * guardrail CLI — entry point
 *
 * Usage:
 *   guardrail run               review git-changed files
 *   guardrail scan src/auth/    review any path (no git required)
 *   guardrail scan --ask "..."  ask a targeted question about code
 *   guardrail ci                opinionated CI entrypoint
 *   guardrail watch             re-run on every file save
 *   guardrail doctor            check prerequisites
 */
import { runCommand } from './run.ts';
import { runWatch } from './watch.ts';
import { runSetup } from './setup.ts';
import { runScaffold } from './scaffold.ts';
import { runDoctor } from './preflight.ts';
import { runCi } from './ci.ts';
import { runFix } from './fix.ts';
import { runScan } from './scan.ts';
import { runReport } from './report.ts';
import { runExplain } from './explain.ts';
import { runIgnore } from './ignore-helper.ts';
import { runPr } from './pr.ts';
import { runBaseline } from './baseline.ts';
import { runTriage } from './triage.ts';
import { runLsp } from './lsp.ts';
import { runWorker } from './worker.ts';
import { runTestGen } from './test-gen.ts';
import { runCouncilCmd } from './council.ts';
import { runMigrateV4 } from './migrate-v4.ts';
import { runMigrateDoctor } from './migrate-doctor.ts';
import { initMigrate, NoMigrationToolDetectedError } from './init-migrate.ts';
import { runMigrate } from './migrate.ts';
import { runDeploy, runDeployRollback, runDeployStatus } from './deploy.ts';
import { findPackageRoot } from './_pkg-root.ts';
import { GuardrailError } from '../core/errors.ts';
import { buildHelpText, buildCommandHelpText } from './help-text.ts';
import { runUnderJsonMode, EXIT_NEEDS_HUMAN } from './json-envelope.ts';

// Format unhandled errors as a one-line user-facing message instead of dumping a
// Node stack trace. Auth/network failures are by far the most common path here
// (bad/missing API key, rate limit, network blip) and surfacing the raw stack
// reads as "the tool is broken" when it isn't.
function formatTopLevelError(err: unknown): { message: string; exit: number } {
  if (err instanceof GuardrailError) {
    const provider = err.provider ? ` [${err.provider}]` : '';
    const hint = err.code === 'auth'
      ? '\n  hint: check your API key (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY) or run: claude-autopilot doctor'
      : err.code === 'rate_limit'
        ? '\n  hint: rate-limited by provider — retry shortly or switch model in guardrail.config.yaml'
        : err.code === 'invalid_config'
          ? '\n  hint: check guardrail.config.yaml — claude-autopilot doctor'
          : '';
    return { message: `[claude-autopilot]${provider} ${err.code}: ${err.message}${hint}`, exit: 1 };
  }
  if (err instanceof Error) {
    return { message: `[claude-autopilot] ${err.message}`, exit: 1 };
  }
  return { message: `[claude-autopilot] ${String(err)}`, exit: 1 };
}

process.on('unhandledRejection', err => {
  const { message, exit } = formatTopLevelError(err);
  process.stderr.write(`\x1b[31m${message}\x1b[0m\n`);
  if (process.env.CLAUDE_AUTOPILOT_DEBUG === '1' && err instanceof Error && err.stack) {
    process.stderr.write(`\x1b[2m${err.stack}\x1b[0m\n`);
  }
  process.exit(exit);
});

process.on('uncaughtException', err => {
  const { message, exit } = formatTopLevelError(err);
  process.stderr.write(`\x1b[31m${message}\x1b[0m\n`);
  if (process.env.CLAUDE_AUTOPILOT_DEBUG === '1' && err.stack) {
    process.stderr.write(`\x1b[2m${err.stack}\x1b[0m\n`);
  }
  process.exit(exit);
});

const args = process.argv.slice(2);

// v7.8.0 — `--tsx-source <bundled|project|path>` resolution-override flag.
// The launcher (bin/_launcher.js) already consumed this to pick the tsx
// binary; here we validate the value, surface a clear error on bad input,
// and strip the tokens from argv before subcommand dispatch so downstream
// parsers don't choke on an unknown flag. See
// docs/specs/v7.8.0-decouple-runtime-deps.md (amendment A2).
const TSX_SOURCE_VALID = ['bundled', 'project', 'path'] as const;
{
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === '--tsx-source' || a.startsWith('--tsx-source=')) {
      const value = a.startsWith('--tsx-source=') ? a.slice('--tsx-source='.length) : args[i + 1];
      if (!value || !(TSX_SOURCE_VALID as readonly string[]).includes(value)) {
        process.stderr.write(
          `\x1b[31m[claude-autopilot] Invalid --tsx-source value '${value ?? ''}'. ` +
            `Expected ${TSX_SOURCE_VALID.join(', ')}.\x1b[0m\n`,
        );
        process.exit(1);
      }
      // Strip the consumed tokens from argv so subcommands don't see them.
      if (a.startsWith('--tsx-source=')) {
        args.splice(i, 1);
      } else {
        args.splice(i, 2);
      }
      i -= 1;
    }
  }
}

// Version flag — read package.json via the shared package-root helper. Works
// under both source (src/cli/index.ts) and compiled (dist/src/cli/index.js)
// layouts since findPackageRoot walks up to the canonical package root.
if (args[0] === '--version' || args[0] === '-v') {
  const root = findPackageRoot(import.meta.url);
  if (root) {
    const nodeFs = await import('node:fs');
    const nodePath = await import('node:path');
    const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(root, 'package.json'), 'utf8')) as { version: string };
    console.log(pkg.version);
  } else {
    console.log('unknown');
  }
  process.exit(0);
}

// Help flag — route to help handler explicitly before subcommand defaulting.
// Without this, `--help` falls through the "args[0].startsWith('--')" check below
// and defaults to `run`, which is surprising and a v4 regression we preserve no longer.
if (args[0] === '--help' || args[0] === '-h') {
  args.unshift('help');
  args.splice(1, 1); // remove the original --help/-h token
}

// Verb grouping (new in alpha.2): `claude-autopilot review <verb>` and
// `claude-autopilot advanced <verb>` are dispatcher prefixes that route to the
// same flat handlers. Legacy flat invocation (`claude-autopilot run`) is unchanged
// — the grouped form is purely additive.
//
// Scope gates enforce that only the documented verb sets work under each prefix,
// so `claude-autopilot review doctor` is rejected with a clear error instead of
// silently routing to the doctor handler (which would confuse the mental model).
const REVIEW_VERBS = new Set(['run', 'scan', 'ci', 'fix', 'baseline', 'explain', 'watch', 'report']);
// `detector` is a library used by setup/run, not a CLI subcommand — leave it out.
const ADVANCED_VERBS = new Set(['lsp', 'mcp', 'worker', 'autoregress', 'test-gen', 'hook', 'ignore']);
if (args[0] === 'review') {
  // v6.0.4 — `review` is BOTH a grouping prefix (legacy alpha.2) AND a flat
  // verb (the new engine-wrapped `runReview`). Disambiguate based on args[1]:
  //
  //   - missing                  → grouping-prefix help banner (legacy V16)
  //   - --help / -h              → grouping-prefix help banner (legacy)
  //   - in REVIEW_VERBS          → grouping prefix (shift, route to flat handler)
  //   - other flag (`--engine`,
  //     `--config`, etc.)        → flat-verb invocation; let `case 'review':` handle it
  //   - anything else            → reject with legacy "not a review-phase verb"
  //
  // The "missing → prefix help" branch preserves the V16 v4-compat test
  // (`claude-autopilot review` alone prints the review-phase verb list);
  // users who want the v6 flat-verb behavior must pass at least one flag
  // (e.g. `--engine`, `--config`, `--context`). `help review` continues to
  // surface the flat-verb Options block via buildCommandHelpText.
  const sub = args[1];
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`
Usage: claude-autopilot review <verb> [options]

Review-phase verbs:
  run          Review git-changed files (default)
  scan         Review any path — no git required
  ci           Opinionated CI entrypoint (post comments + SARIF)
  fix          Auto-fix cached findings using the configured LLM
  baseline     Manage the committed findings baseline
  explain      Deep-dive explanation + remediation for a specific finding
  watch        Watch for file changes and re-run on each save
  report       Render cached findings as a markdown report

These are aliases for the flat subcommands — \`claude-autopilot run\` and
\`claude-autopilot review run\` are equivalent.

The v6 \`review\` phase verb (engine-wrap shell) is invoked with any flag
present, e.g. \`claude-autopilot review --engine\`. See
\`claude-autopilot help review\` for its options.
`);
    process.exit(0);
  }
  if (sub.startsWith('--')) {
    // Flat-verb invocation — fall through; do not shift.
  } else if (!REVIEW_VERBS.has(sub)) {
    console.error(`\x1b[31m[claude-autopilot] "${sub}" is not a review-phase verb.\x1b[0m`);
    console.error(`\x1b[2m  Valid: ${[...REVIEW_VERBS].join(', ')}\x1b[0m`);
    console.error(`\x1b[2m  Did you mean: claude-autopilot ${sub} ...?\x1b[0m`);
    process.exit(1);
  } else {
    args.shift(); // drop 'review', leave the flat subcommand at args[0]
  }
}
if (args[0] === 'advanced') {
  const sub = args[1];
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`
Usage: claude-autopilot advanced <verb> [options]

Advanced / niche verbs (hidden from top-level --help to keep it readable):
  lsp          Language server — publishes findings as LSP diagnostics
  mcp          MCP server for Claude / ChatGPT integration
  worker       Persistent review daemon (start|stop|status)
  autoregress  Snapshot regression tests
  test-gen     Generate test cases for uncovered exports
  hook         Install / remove the pre-push git hook
  ignore       Edit the findings ignore list

These are aliases for the flat subcommands; they still work without the 'advanced' prefix.
`);
    process.exit(0);
  }
  if (!ADVANCED_VERBS.has(sub)) {
    console.error(`\x1b[31m[claude-autopilot] "${sub}" is not an advanced verb.\x1b[0m`);
    console.error(`\x1b[2m  Valid: ${[...ADVANCED_VERBS].join(', ')}\x1b[0m`);
    process.exit(1);
  }
  args.shift(); // drop 'advanced'
}

// `internal` is a hidden verb (v6 Phase 2): markdown-driven skills shell out
// to it to append typed events. Deliberately not in HELP_GROUPS / HELP_VERBS,
// not advertised in the welcome banner. Documented only via
// `claude-autopilot internal --help`.
//
// `runs` (plural) is the v6 Phase 3 umbrella verb — its sub-verbs (list, show,
// gc, delete, doctor) are dispatched inside its case block. The singular
// `run resume` form is handled BEFORE the default `run` -> review dispatch
// kicks in (see disambiguation block just below).
const SUBCOMMANDS = ['init', 'run', 'runs', 'scan', 'report', 'explain', 'ignore', 'ci', 'pr', 'fix', 'costs', 'watch', 'hook', 'autoregress', 'baseline', 'triage', 'lsp', 'worker', 'mcp', 'test-gen', 'pr-desc', 'doctor', 'preflight', 'setup', 'council', 'migrate-v4', 'migrate', 'migrate-doctor', 'deploy', 'brainstorm', 'spec', 'plan', 'implement', 'review', 'validate', 'autopilot', 'examples', 'internal', 'help', '--help', '-h'] as const;
const VALUE_FLAGS = ['base', 'config', 'files', 'format', 'output', 'debounce', 'ask', 'focus', 'fail-on', 'note', 'reason', 'expires', 'profile', 'severity', 'prompt', 'context-file', 'path', 'adapter', 'ref', 'sha', 'spec', 'context', 'mode', 'phases', 'budget', 'stack'];

// Bare invocation — no subcommand, no flags → show welcome guide
if (args.length === 0) {
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY);
  const keyLine = hasKey
    ? '\x1b[32m✓\x1b[0m  LLM API key detected'
    : '\x1b[33m!\x1b[0m  No LLM API key found — set one of:\n     ANTHROPIC_API_KEY  https://console.anthropic.com/\n     OPENAI_API_KEY     https://platform.openai.com/api-keys\n     GEMINI_API_KEY     https://aistudio.google.com/app/apikey\n     GROQ_API_KEY       https://console.groq.com/keys  (fast free tier)';
  console.log(`
\x1b[1m@delegance/claude-autopilot\x1b[0m — Autonomous dev pipeline for Claude Code
      \x1b[2m(brainstorm → spec → plan → implement → migrate → validate → PR → review)\x1b[0m

  ${keyLine}

\x1b[1mQuick start — full pipeline:\x1b[0m

  \x1b[36mclaude-autopilot brainstorm "add SSO for enterprise tenants"\x1b[0m
      Turn an idea into a reviewed spec, then auto-implement end-to-end.

\x1b[1mOr just the review phase (v4 compatible):\x1b[0m

  \x1b[36mclaude-autopilot run --base main\x1b[0m             Review files changed vs main
  \x1b[36mclaude-autopilot scan src/auth/\x1b[0m              Scan any path (no git required)
  \x1b[36mclaude-autopilot scan --ask "SQL injection?" src/db/\x1b[0m
  \x1b[36mclaude-autopilot fix\x1b[0m                         Auto-fix cached findings
  \x1b[36mclaude-autopilot migrate-v4\x1b[0m                  Codemod: migrate v4 config / CI / hooks

\x1b[1mSetup:\x1b[0m

  \x1b[36mclaude-autopilot setup\x1b[0m                       Auto-detect stack, write config, install hook
  \x1b[36mclaude-autopilot doctor\x1b[0m                      Check prerequisites

Run \x1b[36mclaude-autopilot --help\x1b[0m for full command reference.
`);
  process.exit(0);
}

// Detect first non-flag arg as subcommand, default to 'run'.
//
// v6 Phase 3 disambiguation: `run resume <id>` is a v6 verb; the bare `run`
// remains the legacy review-phase entry point. We rewrite the head to a
// synthetic 'run-resume' subcommand so the existing 'run' case keeps doing
// `runReview` and we don't need to special-case it inside the review path.
let subcommand = (args[0] && !args[0].startsWith('--')) ? args[0] : 'run';
if (subcommand === 'run' && args[1] === 'resume') {
  subcommand = 'run-resume';
}

/** Returns value for --name <value>. Exits if value is missing (next token is another flag or absent). */
function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  const val = args[idx + 1];
  if (val === undefined || val.startsWith('--')) {
    console.error(`\x1b[31m[claude-autopilot] --${name} requires a value\x1b[0m`);
    process.exit(1);
  }
  return val;
}

function boolFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

/**
 * v7.0 — `--no-engine` removed; `--engine` becomes a no-op shim with a
 * one-shot per-process deprecation warning to stderr (codex pass-3
 * NOTE #2). The engine is unconditionally on.
 *
 * Behavior:
 *   - `--no-engine` → exit 1 with `invalid_config` and a removal hint.
 *   - `--engine`    → emit one stderr deprecation line per process; return.
 *   - neither       → no-op; return.
 */
let __engineDeprecationWarned = false;
import {
  ENGINE_FLAG_DEPRECATION_MESSAGE,
  ENGINE_OFF_REMOVED_MESSAGE,
  ENGINE_OFF_ENV_REMOVED_MESSAGE,
} from './engine-flag-deprecation.ts';

function parseEngineCliFlag(): undefined {
  if (args.includes('--no-engine')) {
    console.error(
      `\x1b[31m[claude-autopilot] invalid_config: ${ENGINE_OFF_REMOVED_MESSAGE}\x1b[0m`,
    );
    process.exit(1);
  }
  if (args.includes('--engine') && !__engineDeprecationWarned) {
    __engineDeprecationWarned = true;
    process.stderr.write(`${ENGINE_FLAG_DEPRECATION_MESSAGE}\n`);
  }
  checkEngineOffEnvDeprecation();
  // v7.0 — engine is always on; the resolver ignores cliEngine. We
  // return undefined so `cliEngine` never gets spread into the
  // resolver opts (keeps call sites identical and source-compatible).
  return undefined;
}

// Test seam: reset the per-process deprecation latch so tests that drive
// the flag multiple times in one process can exercise the "warn once"
// behavior repeatably.
export function _resetEngineDeprecationLatchForTests(): void {
  __engineDeprecationWarned = false;
}

/**
 * v7.0 — `CLAUDE_AUTOPILOT_ENGINE=off` is softer than `--no-engine`:
 * emit a one-shot warning + return undefined so the engine remains on.
 * Per spec: env vars in CI are sticky and silently breaking every
 * v6.x → v7 upgrade in CI on day one would burn user trust.
 */
let __engineEnvOffWarned = false;
function checkEngineOffEnvDeprecation(): void {
  const raw = process.env.CLAUDE_AUTOPILOT_ENGINE;
  if (!raw) return;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'false' || normalized === '0' || normalized === 'no') {
    if (!__engineEnvOffWarned) {
      __engineEnvOffWarned = true;
      process.stderr.write(`${ENGINE_OFF_ENV_REMOVED_MESSAGE}\n`);
    }
  }
}

export function _resetEngineEnvOffLatchForTests(): void {
  __engineEnvOffWarned = false;
}

/**
 * Run the migrate-doctor with shared CLI formatting and exit handling.
 *
 * Both `migrate doctor` (two-word) and `migrate-doctor` (single-verb alias)
 * resolve to this helper to keep their behavior locked together.
 *
 * Phase 5: also handles --json (envelope on stdout, no human banner).
 */
async function runMigrateDoctorCLI(): Promise<never> {
  const fix = args.includes('--fix');
  const json = args.includes('--json');
  let docResult: Awaited<ReturnType<typeof runMigrateDoctor>> | null = null;
  const code = await runUnderJsonMode(
    {
      command: 'migrate-doctor',
      active: json,
      payload: () => docResult ? {
        results: docResult.results,
        mutations: docResult.mutations ?? [],
        migrationReportPath: docResult.migrationReportPath,
        allOk: docResult.allOk,
      } : {},
      statusFor: exit => exit === 0 ? 'pass' : 'fail',
    },
    async () => {
      docResult = await runMigrateDoctor({ repoRoot: process.cwd(), fix });
      for (const r of docResult.results) {
        const mark = r.result.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
        console.log(`${mark} ${r.name}${r.result.message ? ` — ${r.result.message}` : ''}`);
        if (!r.result.ok && r.result.fixHint) {
          console.log(`  \x1b[2mhint: ${r.result.fixHint}\x1b[0m`);
        }
      }
      if (docResult.mutations && docResult.mutations.length > 0) {
        console.log(`\n\x1b[1mFixes applied:\x1b[0m`);
        for (const m of docResult.mutations) console.log(`  - ${m}`);
      }
      if (docResult.migrationReportPath) {
        console.log(`\n\x1b[2mMigration report: ${docResult.migrationReportPath}\x1b[0m`);
      }
      return docResult.allOk ? 0 : 1;
    },
  );
  process.exit(code);
}

function printUsage(): void {
  process.stdout.write(buildHelpText());
}

switch (subcommand) {
  case 'scan': {
    const config = flag('config');
    const ask = flag('ask');
    const focusArg = flag('focus');
    if (focusArg && !['security', 'logic', 'performance', 'brand', 'all'].includes(focusArg)) {
      console.error(`\x1b[31m[claude-autopilot] --focus must be "security", "logic", "performance", or "all"\x1b[0m`);
      process.exit(1);
    }
    const dryRun = boolFlag('dry-run');
    const all = boolFlag('all');
    const json = boolFlag('json');
    // v6.0.1 — engine knob. CLI flag wins; env / config / default resolved
    // inside runScan once it's loaded the config file.
    const cliEngine = parseEngineCliFlag();
    // Remaining non-flag args after 'scan' are paths
    const targets = args.slice(1).filter(a => !a.startsWith('--') && a !== ask && a !== focusArg && a !== config);
    const code = await runUnderJsonMode(
      { command: 'scan', active: json },
      () => runScan({
        configPath: config,
        targets: targets.length > 0 ? targets : undefined,
        all,
        ask,
        focus: focusArg as 'security' | 'logic' | 'performance' | 'brand' | 'all' | undefined,
        dryRun,
        ...(cliEngine !== undefined ? { cliEngine } : {}),
        envEngine: process.env.CLAUDE_AUTOPILOT_ENGINE,
      }),
    );
    process.exit(code);
    break;
  }

  case 'init': {
    // `init` and `setup` are aliases. Keep both supported — no nag banner.
    const force = args.includes('--force');
    const json = boolFlag('json');
    const code = await runUnderJsonMode(
      { command: 'init', active: json },
      async () => {
        await runSetup({ force });

        // After the existing init/setup logic, sniff for a migration tool and write
        // .autopilot/stack.md. Non-interactive: high-confidence single matches are
        // auto-selected; ambiguity / no-match downgrades to a TODO 'none@1' shape so
        // we don't block the user. (Interactive prompts come from the autopilot skill,
        // not the CLI.)
        try {
          const result = await initMigrate({
            repoRoot: process.cwd(),
            force,
          });
          for (const ws of result.workspaces) {
            const rel = ws.workspace === process.cwd() ? '.' : ws.workspace;
            console.log(`\x1b[2m[init-migrate] ${ws.action} ${rel}/.autopilot/stack.md (skill: ${ws.skill})\x1b[0m`);
          }
        } catch (err) {
          if (err instanceof NoMigrationToolDetectedError) {
            // No high-confidence match — fall back to skipMigrate shape so the user
            // can edit it later. This matches the auto-detection contract documented
            // in the v5.2.0 CHANGELOG.
            try {
              await initMigrate({
                repoRoot: process.cwd(),
                force,
                skipMigrate: true,
              });
              console.log(`\x1b[33m[init-migrate] No migration tool detected — wrote 'none@1' stack.md (edit .autopilot/stack.md to configure)\x1b[0m`);
            } catch (fallbackErr) {
              console.error(`\x1b[31m[init-migrate] failed: ${(fallbackErr as Error).message}\x1b[0m`);
              return 1;
            }
          } else {
            console.error(`\x1b[31m[init-migrate] failed: ${(err as Error).message}\x1b[0m`);
            return 1;
          }
        }
        return 0;
      },
    );
    if (json) process.exit(code);
    break;
  }

  case 'doctor':
  case 'preflight': {
    const json = boolFlag('json');
    let docResult: Awaited<ReturnType<typeof runDoctor>> | null = null;
    const code = await runUnderJsonMode(
      {
        command: subcommand,
        active: json,
        payload: () => docResult ? {
          blockers: docResult.blockers,
          warnings: docResult.warnings,
        } : {},
      },
      async () => {
        docResult = await runDoctor();
        return docResult.blockers > 0 ? 1 : 0;
      },
    );
    process.exit(code);
    break;
  }

  case 'help':
  case '--help':
  case '-h': {
    // `claude-autopilot help <command>` — focused per-command help. Falls back
    // to the full two-level listing with an "unknown command" notice + exit 1
    // when the named verb isn't documented.
    const target = args[1];
    if (target && !target.startsWith('-')) {
      const focused = buildCommandHelpText(target);
      if (focused !== null) {
        process.stdout.write(focused);
        process.exit(0);
      }
      process.stderr.write(`\x1b[31m[claude-autopilot] unknown command: "${target}"\x1b[0m\n`);
      process.stdout.write(buildHelpText());
      process.exit(1);
    }
    printUsage();
    break;
  }

  case 'watch': {
    const config = flag('config');
    const debounceArg = flag('debounce');
    const debounceMs = debounceArg ? parseInt(debounceArg, 10) : undefined;
    if (debounceArg && (isNaN(debounceMs!) || debounceMs! < 0)) {
      console.error(`\x1b[31m[claude-autopilot] --debounce must be a non-negative integer\x1b[0m`);
      process.exit(1);
    }
    await runWatch({ configPath: config, debounceMs });
    break;
  }

  case 'run': {
    const base = flag('base');
    const config = flag('config');
    const filesArg = flag('files');
    const dryRun = boolFlag('dry-run');
    const diff = boolFlag('diff');
    const delta = boolFlag('delta');
    const staticOnly = args.includes('--static-only');
    const inlineComments = boolFlag('inline-comments');
    const postComments = boolFlag('post-comments');
    const formatArg = flag('format');
    const outputPath = flag('output');

    if (formatArg && formatArg !== 'text' && formatArg !== 'sarif' && formatArg !== 'junit') {
      console.error(`\x1b[31m[claude-autopilot] --format must be "text", "sarif", or "junit"\x1b[0m`);
      process.exit(1);
    }
    if ((formatArg === 'sarif' || formatArg === 'junit') && !outputPath) {
      console.error(`\x1b[31m[claude-autopilot] --format ${formatArg} requires --output <path>\x1b[0m`);
      process.exit(1);
    }

    const failOnArg = flag('fail-on');
    if (failOnArg && !['critical', 'warning', 'note', 'none'].includes(failOnArg)) {
      console.error(`\x1b[31m[claude-autopilot] --fail-on must be "critical", "warning", "note", or "none"\x1b[0m`);
      process.exit(1);
    }
    const newOnly = boolFlag('new-only');
    const json = boolFlag('json');

    const code = await runUnderJsonMode(
      { command: 'run', active: json },
      () => runCommand({
        base,
        configPath: config,
        files: filesArg ? filesArg.split(',').map(f => f.trim()) : undefined,
        dryRun,
        diff,
        delta,
        newOnly,
        failOn: failOnArg as 'critical' | 'warning' | 'note' | 'none' | undefined,
        inlineComments,
        postComments,
        format: formatArg as 'text' | 'sarif' | 'junit' | undefined,
        outputPath,
        skipReview: staticOnly,
      }),
    );
    process.exit(code);
    break;
  }

  case 'ci': {
    const base = flag('base');
    const config = flag('config');
    const outputPath = flag('output');
    const noPostComments = boolFlag('no-post-comments');
    const noInlineComments = boolFlag('no-inline-comments');
    const diff = boolFlag('diff');
    const newOnly = boolFlag('new-only');
    const failOnArg = flag('fail-on');
    const json = boolFlag('json');
    const code = await runUnderJsonMode(
      { command: 'ci', active: json },
      () => runCi({
        configPath: config,
        base,
        sarifOutput: outputPath,
        postComments: noPostComments ? false : undefined,
        inlineComments: noInlineComments ? false : undefined,
        diff,
        newOnly,
        failOn: failOnArg as 'critical' | 'warning' | 'note' | 'none' | undefined,
      }),
    );
    process.exit(code);
    break;
  }

  case 'baseline': {
    const { runBaseline: rb } = await import('./baseline.ts');
    const sub = args[1] ?? 'show';
    const note = flag('note');
    const config = flag('config');
    const json = boolFlag('json');
    const code = await runUnderJsonMode(
      { command: `baseline ${sub}`, active: json },
      () => rb(sub, { cwd: process.cwd(), note, baselinePath: config }),
    );
    process.exit(code);
    break;
  }

  case 'pr': {
    // v6.0.9 — engine-wrap shell for the `pr` pipeline phase. Side-effecting
    // (posts/updates a PR comment + inline review comments via the `gh` CLI
    // inside runCommand). Declared `idempotent: false, hasSideEffects: true`
    // with a `github-pr` externalRef recorded before the inner pipeline
    // runs. See the long declaration note in src/cli/pr.ts for the
    // per-call breakdown of what `gh` mutations happen and why the
    // declaration matches the v6 spec table.
    const config = flag('config');
    const noPostComments = boolFlag('no-post-comments');
    const noInlineComments = boolFlag('no-inline-comments');
    const json = boolFlag('json');
    const prNumber = args.slice(1).find(a => !a.startsWith('--') && /^\d+$/.test(a));
    // v6.0.9 — engine knob. CLI flag wins; env / config / default resolved
    // inside runPr once it's loaded the config file.
    const cliEngine = parseEngineCliFlag();
    const code = await runUnderJsonMode(
      { command: 'pr', active: json },
      () => runPr({
        configPath: config,
        prNumber,
        noPostComments,
        noInlineComments,
        ...(cliEngine !== undefined ? { cliEngine } : {}),
        envEngine: process.env.CLAUDE_AUTOPILOT_ENGINE,
      }),
    );
    process.exit(code);
    break;
  }

  case 'hook': {
    const { runHook } = await import('./hook.ts');
    const hookSub = args[1] ?? 'status';
    const force = boolFlag('force');
    const code = await runHook(hookSub, {
      force,
      preCommitOnly: args.includes('--pre-commit-only'),
      prePushOnly: args.includes('--pre-push-only'),
    });
    process.exit(code);
    break;
  }

  case 'autoregress': {
    const { runAutoregress } = await import('./autoregress-bridge.ts');
    const code = runAutoregress(args.slice(1));
    process.exit(code);
    break;
  }

  case 'fix': {
    const config = flag('config');
    const severityArg = flag('severity');
    if (severityArg && !['critical', 'warning', 'all'].includes(severityArg)) {
      console.error(`\x1b[31m[claude-autopilot] --severity must be "critical", "warning", or "all"\x1b[0m`);
      process.exit(1);
    }
    const dryRun = boolFlag('dry-run');
    const noVerify = boolFlag('no-verify');
    const json = boolFlag('json');
    // v6.0.2 — engine knob. CLI flag wins; env / config / default resolved
    // inside runFix once it's loaded the config file.
    const cliEngine = parseEngineCliFlag();
    const code = await runUnderJsonMode(
      { command: 'fix', active: json },
      () => runFix({
        configPath: config,
        severity: severityArg as 'critical' | 'warning' | 'all' | undefined,
        dryRun,
        noVerify,
        ...(cliEngine !== undefined ? { cliEngine } : {}),
        envEngine: process.env.CLAUDE_AUTOPILOT_ENGINE,
      }),
    );
    process.exit(code);
    break;
  }

  case 'triage': {
    const sub = args[1];
    const rest = args.slice(2);
    const json = boolFlag('json');
    const code = await runUnderJsonMode(
      { command: `triage${sub ? ` ${sub}` : ''}`, active: json },
      () => runTriage(sub, rest),
    );
    process.exit(code);
    break;
  }

  case 'test-gen': {
    const config = flag('config');
    const base = flag('base');
    const dryRun = boolFlag('dry-run');
    const verify = boolFlag('verify');
    const json = boolFlag('json');
    const targets = args.slice(1).filter(a => !a.startsWith('--') && a !== config && a !== base);
    const code = await runUnderJsonMode(
      { command: 'test-gen', active: json },
      () => runTestGen({
        cwd: process.cwd(),
        configPath: config,
        targets: targets.length > 0 ? targets : undefined,
        base,
        dryRun,
        verify,
      }),
    );
    process.exit(code);
    break;
  }

  case 'pr-desc': {
    const { runPrDesc } = await import('./pr-desc.ts');
    const baseIdx = args.indexOf('--base');
    const base = baseIdx !== -1 ? args[baseIdx + 1] : undefined;
    const outputIdx = args.indexOf('--output');
    const output = outputIdx !== -1 ? args[outputIdx + 1] : undefined;
    const json = boolFlag('json');
    const code = await runUnderJsonMode(
      { command: 'pr-desc', active: json },
      async () => {
        await runPrDesc({
          base,
          post: args.includes('--post'),
          yes: args.includes('--yes'),
          output,
        });
        return 0;
      },
    );
    if (json) process.exit(code);
    break;
  }

  case 'lsp': {
    await runLsp({ cwd: process.cwd() });
    break;
  }

  case 'costs': {
    const { runCosts } = await import('./costs.ts');
    const json = boolFlag('json');
    const config = flag('config');
    // v6.0.2 — engine knob. CLI flag wins; env / config / default resolved
    // inside runCosts once it's loaded the config file.
    const cliEngine = parseEngineCliFlag();
    const code = await runUnderJsonMode(
      { command: 'costs', active: json },
      () => runCosts({
        ...(config !== undefined ? { configPath: config } : {}),
        ...(cliEngine !== undefined ? { cliEngine } : {}),
        envEngine: process.env.CLAUDE_AUTOPILOT_ENGINE,
      }),
    );
    process.exit(code);
    break;
  }

  case 'plan': {
    // v6.0.4 — engine-wrap shell for the `plan` pipeline phase. The actual
    // LLM-driven planning content is produced by the Claude Code
    // superpowers:writing-plans skill; this CLI verb provides a
    // checkpointable phase shell so v6 pipeline runs can record a `plan`
    // entry. Mirrors the costs/scan/fix dispatcher shape.
    const { runPlan } = await import('./plan.ts');
    const json = boolFlag('json');
    const config = flag('config');
    const specPath = flag('spec');
    const outputPath = flag('output');
    const cliEngine = parseEngineCliFlag();
    const code = await runUnderJsonMode(
      { command: 'plan', active: json },
      () => runPlan({
        ...(config !== undefined ? { configPath: config } : {}),
        ...(specPath !== undefined ? { specPath } : {}),
        ...(outputPath !== undefined ? { outputPath } : {}),
        ...(cliEngine !== undefined ? { cliEngine } : {}),
        envEngine: process.env.CLAUDE_AUTOPILOT_ENGINE,
      }),
    );
    process.exit(code);
    break;
  }

  case 'review': {
    // v6.0.4 — engine-wrap shell for the `review` pipeline phase. The actual
    // LLM-driven review content is produced by the Claude Code review skills
    // (`/review`, `/review-2pass`, `pr-review-toolkit:review-pr`). PR-side
    // comment posting lives in `claude-autopilot pr --inline-comments` /
    // `--post-comments`; this verb does not post anywhere. See the long
    // deviation note in src/cli/review.ts for the idempotent / hasSideEffects
    // declaration rationale.
    const { runReview } = await import('./review.ts');
    const json = boolFlag('json');
    const config = flag('config');
    const context = flag('context');
    const outputPath = flag('output');
    const cliEngine = parseEngineCliFlag();
    const code = await runUnderJsonMode(
      { command: 'review', active: json },
      () => runReview({
        ...(config !== undefined ? { configPath: config } : {}),
        ...(context !== undefined ? { context } : {}),
        ...(outputPath !== undefined ? { outputPath } : {}),
        ...(cliEngine !== undefined ? { cliEngine } : {}),
        envEngine: process.env.CLAUDE_AUTOPILOT_ENGINE,
      }),
    );
    process.exit(code);
    break;
  }

  case 'validate': {
    // v6.0.5 — engine-wrap shell for the `validate` pipeline phase. The
    // actual validation pipeline (static checks, auto-fix, tests, Codex
    // review with auto-fix, bugbot triage) lives in the Claude Code
    // `/validate` skill; this verb provides a checkpointable phase shell so
    // v6 pipeline runs can record a `validate` entry. Mirrors the
    // plan / review dispatcher shape. See the long deviation note in
    // src/cli/validate.ts for the externalRefs / sarif-artifact
    // declaration rationale.
    const { runValidate } = await import('./validate.ts');
    const json = boolFlag('json');
    const config = flag('config');
    const context = flag('context');
    const outputPath = flag('output');
    const cliEngine = parseEngineCliFlag();
    const code = await runUnderJsonMode(
      { command: 'validate', active: json },
      () => runValidate({
        ...(config !== undefined ? { configPath: config } : {}),
        ...(context !== undefined ? { context } : {}),
        ...(outputPath !== undefined ? { outputPath } : {}),
        ...(cliEngine !== undefined ? { cliEngine } : {}),
        envEngine: process.env.CLAUDE_AUTOPILOT_ENGINE,
      }),
    );
    process.exit(code);
    break;
  }

  case 'implement': {
    // v6.0.7 — engine-wrap shell for the `implement` pipeline phase. The
    // actual implement loop (read plan → dispatch subagents one per plan
    // phase via `subagent-driven-development` → write code → run tests →
    // commit → optionally push via `commit-push-pr`) lives in the Claude
    // Code `claude-autopilot` skill; this verb provides a checkpointable
    // phase shell so v6 pipeline runs can record an `implement` entry.
    // Mirrors the plan / review / validate dispatcher shape. See the long
    // deviation note in src/cli/implement.ts for the idempotent /
    // hasSideEffects / git-remote-push declaration rationale.
    const { runImplement } = await import('./implement.ts');
    const json = boolFlag('json');
    const config = flag('config');
    const context = flag('context');
    const plan = flag('plan');
    const outputPath = flag('output');
    const cliEngine = parseEngineCliFlag();
    const code = await runUnderJsonMode(
      { command: 'implement', active: json },
      () => runImplement({
        ...(config !== undefined ? { configPath: config } : {}),
        ...(context !== undefined ? { context } : {}),
        ...(plan !== undefined ? { plan } : {}),
        ...(outputPath !== undefined ? { outputPath } : {}),
        ...(cliEngine !== undefined ? { cliEngine } : {}),
        envEngine: process.env.CLAUDE_AUTOPILOT_ENGINE,
      }),
    );
    process.exit(code);
    break;
  }

  case 'autopilot': {
    // v6.2.0 — multi-phase orchestrator. One runId across all phases.
    // Engine-on REQUIRED (rejected at pre-flight if --no-engine / env=off
    // / config=false). v6.2.0 ships --mode=full (scan → spec → plan →
    // implement); v6.2.1 extends to scan → spec → plan → implement →
    // migrate → pr; v6.2.2 adds the `--json` outer envelope.
    const { runAutopilot, runAutopilotWithJsonEnvelope } = await import('./autopilot.ts');
    const json = boolFlag('json');
    const modeArg = flag('mode');
    if (modeArg !== undefined && modeArg !== 'full') {
      // In --json mode emit the spec envelope instead of stderr text so
      // CI consumers get a deterministic shape even on this synchronous
      // pre-run validation failure.
      if (json) {
        const { writeAutopilotEnvelope } = await import('./json-envelope.ts');
        writeAutopilotEnvelope({
          runId: null,
          status: 'failed',
          exitCode: 1,
          phases: [],
          totalCostUSD: 0,
          durationMs: 0,
          errorCode: 'invalid_config',
          errorMessage: `--mode "${modeArg}" not supported (use --mode=full)`,
        });
        process.exit(1);
      }
      console.error(
        `\x1b[31m[claude-autopilot] invalid_config: --mode "${modeArg}" not supported (use --mode=full)\x1b[0m`,
      );
      console.error(`\x1b[2m  --mode=fix and --mode=review land in v6.2.x+; use --phases=<csv> for custom lists\x1b[0m`);
      process.exit(1);
    }
    const phasesArg = flag('phases');
    const phases = phasesArg
      ? phasesArg.split(',').map(s => s.trim()).filter(s => s.length > 0)
      : undefined;
    const budgetRaw = flag('budget');
    let budgetUSD: number | undefined;
    if (budgetRaw !== undefined) {
      const parsed = Number.parseFloat(budgetRaw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        if (json) {
          const { writeAutopilotEnvelope } = await import('./json-envelope.ts');
          writeAutopilotEnvelope({
            runId: null,
            status: 'failed',
            exitCode: 1,
            phases: [],
            totalCostUSD: 0,
            durationMs: 0,
            errorCode: 'invalid_config',
            errorMessage: `--budget must be a positive number, got "${budgetRaw}"`,
          });
          process.exit(1);
        }
        console.error(
          `\x1b[31m[claude-autopilot] invalid_config: --budget must be a positive number, got "${budgetRaw}"\x1b[0m`,
        );
        process.exit(1);
      }
      budgetUSD = parsed;
    }
    const cliEngine = parseEngineCliFlag();
    const noUpload = boolFlag('no-upload');
    if (json) {
      const exitCode = await runAutopilotWithJsonEnvelope({
        cwd: process.cwd(),
        mode: 'full',
        ...(phases !== undefined ? { phases } : {}),
        ...(budgetUSD !== undefined ? { budgetUSD } : {}),
        ...(cliEngine !== undefined ? { cliEngine } : {}),
        ...(noUpload ? { noUpload: true } : {}),
        envEngine: process.env.CLAUDE_AUTOPILOT_ENGINE,
      });
      process.exit(exitCode);
    }
    const result = await runAutopilot({
      cwd: process.cwd(),
      mode: 'full',
      ...(phases !== undefined ? { phases } : {}),
      ...(budgetUSD !== undefined ? { budgetUSD } : {}),
      ...(cliEngine !== undefined ? { cliEngine } : {}),
      ...(noUpload ? { noUpload: true } : {}),
      envEngine: process.env.CLAUDE_AUTOPILOT_ENGINE,
    });
    process.exit(result.exitCode);
    break;
  }

  case 'report': {
    const outputPath = flag('output');
    const trend = boolFlag('trend');
    const json = boolFlag('json');
    const code = await runUnderJsonMode(
      { command: 'report', active: json },
      () => runReport({ output: outputPath, trend }),
    );
    process.exit(code);
    break;
  }

  case 'explain': {
    const config = flag('config');
    const json = boolFlag('json');
    // Target is the first non-flag arg after 'explain'
    const target = args.slice(1).find(a => !a.startsWith('--'));
    const code = await runUnderJsonMode(
      { command: 'explain', active: json },
      () => runExplain({ configPath: config, target }),
    );
    process.exit(code);
    break;
  }

  case 'ignore': {
    const all = boolFlag('all');
    const dryRun = boolFlag('dry-run');
    const code = await runIgnore({ all, dryRun });
    process.exit(code);
    break;
  }

  case 'setup': {
    const force = args.includes('--force');
    const profileArg = flag('profile');
    const json = boolFlag('json');
    if (profileArg && !['security-strict', 'team', 'solo'].includes(profileArg)) {
      console.error(`\x1b[31m[claude-autopilot] --profile must be "security-strict", "team", or "solo"\x1b[0m`);
      process.exit(1);
    }
    const code = await runUnderJsonMode(
      { command: 'setup', active: json },
      async () => {
        await runSetup({ force, profile: profileArg as 'security-strict' | 'team' | 'solo' | undefined });
        return 0;
      },
    );
    if (json) process.exit(code);
    break;
  }

  case 'worker': {
    const sub = args[1];
    const config = flag('config');
    const code = await runWorker(sub, { cwd: process.cwd(), configPath: config });
    process.exit(code);
    break;
  }

  case 'scaffold': {
    // v7.2.0 — `claude-autopilot scaffold --from-spec <path>`
    // v7.4.0 — `--stack <node|python|fastapi>` + `--list-stacks`.
    // v7.6.0 — `--stack go`.
    // v7.7.0 — `--stack rust`.
    if (boolFlag('list-stacks')) {
      const { printStackList } = await import('./scaffold.ts');
      printStackList();
      process.exit(0);
    }
    const fromSpec = flag('from-spec');
    const dryRun = boolFlag('dry-run');
    const stackArg = flag('stack');
    if (stackArg && !['node', 'python', 'fastapi', 'go', 'rust'].includes(stackArg)) {
      console.error(
        `\x1b[31m[claude-autopilot] --stack "${stackArg}" not recognized — supported: node, python, fastapi, go, rust\x1b[0m`,
      );
      console.error(`  See: claude-autopilot scaffold --list-stacks`);
      process.exit(3);
    }
    if (!fromSpec) {
      console.error(`\x1b[31m[claude-autopilot] scaffold requires --from-spec <path>\x1b[0m`);
      console.error(`  Example: claude-autopilot scaffold --from-spec docs/specs/foo.md`);
      console.error(`  Stacks:  claude-autopilot scaffold --list-stacks`);
      process.exit(1);
    }
    await runScaffold({
      specPath: fromSpec,
      dryRun,
      ...(stackArg ? { stack: stackArg as 'node' | 'python' | 'fastapi' | 'go' | 'rust' } : {}),
    });
    process.exit(0);
    break;
  }

  case 'examples': {
    // v7.7.1 — `claude-autopilot examples [<stack>]`. Bridges the
    // discoverability gap between `setup` and `scaffold --from-spec` —
    // new users don't know what a spec looks like. Optional positional
    // arg selects a single stack; no arg lists all five.
    const { runExamples } = await import('./examples.ts');
    const target = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    const code = runExamples(target);
    process.exit(code);
    break;
  }

  case 'council': {
    const config = flag('config');
    const prompt = flag('prompt');
    const contextFile = flag('context-file');
    const dryRun = boolFlag('dry-run');
    const noSynthesize = boolFlag('no-synthesize');
    const json = boolFlag('json');
    const code = await runUnderJsonMode(
      { command: 'council', active: json },
      () => runCouncilCmd({
        prompt,
        contextFile,
        configPath: config,
        dryRun,
        noSynthesize,
      }),
    );
    process.exit(code);
    break;
  }

  case 'mcp': {
    let runMcp: (opts: { cwd: string; configPath?: string }) => Promise<void>;
    try {
      ({ runMcp } = await import('./mcp.ts'));
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      const msg = (err as Error).message ?? String(err);
      // The mcp module imports @modelcontextprotocol/sdk at the top — if the
      // package was installed with --omit=optional the dynamic import surfaces
      // ERR_MODULE_NOT_FOUND naming the SDK. Translate to a friendly hint.
      if ((code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') && /modelcontextprotocol/.test(msg)) {
        console.error('\x1b[31m[claude-autopilot] mcp subcommand requires @modelcontextprotocol/sdk\x1b[0m');
        console.error('  install: npm install @modelcontextprotocol/sdk');
        process.exit(1);
      }
      throw err;
    }
    const configPath = flag('config');
    await runMcp({ cwd: process.cwd(), configPath });
    break;
  }

  case 'migrate-v4': {
    const json = boolFlag('json');
    const code = await runUnderJsonMode(
      { command: 'migrate-v4', active: json },
      () => runMigrateV4({
        cwd: flag('path') ?? process.cwd(),
        write: boolFlag('write'),
        undo: boolFlag('undo'),
      }),
    );
    process.exit(code);
    break;
  }

  case 'migrate': {
    // Two-word `migrate doctor` is dispatched here before the generic migrate
    // path so we don't try to read a stack.md or pick an env when the user is
    // really asking for the doctor. `migrate-doctor` (single verb, below) is
    // an equivalent alias.
    if (args[1] === 'doctor') {
      await runMigrateDoctorCLI();
      break;
    }

    // Plain `migrate [--env <name>] [--dry-run] [--yes]` → dispatcher.
    // v6.0.8: routed through `runMigrate` (src/cli/migrate.ts) which
    // wraps the dispatcher in a `RunPhase<MigrateInput, MigrateOutput>`
    // with `--engine` / `--no-engine` precedence. Engine-off is byte-for-
    // byte identical to v6.0.7 — same dispatch shape, same render lines.
    const envName = flag('env') ?? 'dev';
    const dryRun = boolFlag('dry-run');
    const yesFlag = boolFlag('yes');
    const json = boolFlag('json');
    const cliEngine = parseEngineCliFlag();

    // Capture migrate result in an outer ref so the wrapper's payload
    // callback can surface its structured fields in --json mode.
    let migrateResult: Awaited<ReturnType<typeof runMigrate>>['result'] = null;
    const code = await runUnderJsonMode(
      {
        command: 'migrate',
        active: json,
        payload: () => migrateResult ? {
          migrate: {
            status: migrateResult.status,
            reasonCode: migrateResult.reasonCode,
            appliedMigrations: migrateResult.appliedMigrations,
            nextActions: migrateResult.nextActions,
          },
          ...(migrateResult.nextActions.length > 0 ? { nextActions: migrateResult.nextActions } : {}),
        } : {},
        statusFor: exit => {
          if (!migrateResult) return exit === 0 ? 'pass' : 'fail';
          return migrateResult.status === 'applied' || migrateResult.status === 'skipped' ? 'pass' : 'fail';
        },
      },
      async () => {
        const out = await runMigrate({
          cwd: process.cwd(),
          env: envName,
          dryRun,
          yesFlag,
          nonInteractive: json || !process.stdin.isTTY,
          ...(cliEngine !== undefined ? { cliEngine } : {}),
          envEngine: process.env.CLAUDE_AUTOPILOT_ENGINE,
        });
        migrateResult = out.result;
        return out.exitCode;
      },
    );
    process.exit(code);
    break;
  }

  case 'migrate-doctor': {
    // Single-verb alias for `migrate doctor`. Documented for users whose shells
    // or CI configs handle multi-word verbs awkwardly.
    await runMigrateDoctorCLI();
    break;
  }

  case 'deploy': {
    const config = flag('config');
    const adapterArg = flag('adapter');
    // Keep this list in sync with `DeployConfig.adapter` in
    // src/adapters/deploy/types.ts and the factory in
    // src/adapters/deploy/index.ts.
    const ADAPTER_NAMES = ['vercel', 'fly', 'render', 'generic'] as const;
    type AdapterName = typeof ADAPTER_NAMES[number];
    if (adapterArg && !ADAPTER_NAMES.includes(adapterArg as AdapterName)) {
      console.error(
        `\x1b[31m[claude-autopilot] --adapter must be one of: ${ADAPTER_NAMES.join(', ')}\x1b[0m`,
      );
      process.exit(1);
    }
    // Phase 3 — `deploy rollback` and `deploy status` subverbs. The first
    // non-flag positional after `deploy` selects the verb. The historic
    // `claude-autopilot deploy` (no subverb) keeps calling runDeploy.
    const subverb = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    const json = boolFlag('json');
    if (subverb === 'rollback') {
      const to = flag('to');
      const code = await runUnderJsonMode(
        { command: 'deploy rollback', active: json },
        () => runDeployRollback({
          configPath: config,
          adapterOverride: adapterArg as AdapterName | undefined,
          to,
        }),
      );
      process.exit(code);
    }
    if (subverb === 'status') {
      const code = await runUnderJsonMode(
        { command: 'deploy status', active: json },
        () => runDeployStatus({
          configPath: config,
          adapterOverride: adapterArg as AdapterName | undefined,
        }),
      );
      process.exit(code);
    }
    if (subverb !== undefined) {
      console.error(
        `\x1b[31m[claude-autopilot] unknown deploy subverb "${subverb}" — valid: rollback, status\x1b[0m`,
      );
      process.exit(1);
    }
    const ref = flag('ref');
    const commitSha = flag('sha');
    const watch = boolFlag('watch');
    const prRaw = flag('pr');
    let prNum: number | undefined;
    if (prRaw !== undefined) {
      const n = parseInt(prRaw, 10);
      if (Number.isNaN(n) || n <= 0) {
        console.error(
          `\x1b[31m[claude-autopilot] --pr must be a positive integer, got "${prRaw}"\x1b[0m`,
        );
        process.exit(1);
      }
      prNum = n;
    }
    const code = await runUnderJsonMode(
      { command: 'deploy', active: json },
      () => runDeploy({
        configPath: config,
        adapterOverride: adapterArg as AdapterName | undefined,
        ref,
        commitSha,
        watch,
        pr: prNum,
      }),
    );
    process.exit(code);
    break;
  }

  case 'brainstorm': {
    // v6.0.3 — `brainstorm` is wrapped through `runPhase`. Engine-off path
    // is byte-for-byte identical to v6.0.2 (advisory print pointing at the
    // Claude Code skill); engine-on path creates a run dir + emits
    // run.start/phase.start/phase.success/run.complete events. See
    // src/cli/brainstorm.ts for the deviation rationale on
    // `idempotent: true` vs. the spec table's `idempotent: no`.
    const { runBrainstorm } = await import('./brainstorm.ts');
    const json = boolFlag('json');
    const config = flag('config');
    const cliEngine = parseEngineCliFlag();
    if (json) {
      // --json mode: surface the resume hint via nextActions, not a banner.
      // Mirror the v6.0.2 envelope shape so existing consumers (the
      // json-channel-discipline test, MCP wrappers) don't break. The phase
      // body itself runs in silent mode — engine-on still produces
      // run-state artifacts; engine-off short-circuits to 0.
      const code = await runUnderJsonMode(
        {
          command: 'brainstorm',
          active: true,
          payload: () => ({
            note: 'brainstorm is a Claude Code skill, not a CLI subcommand',
            nextActions: [
              'Invoke /brainstorm from Claude Code for interactive spec writing',
              'Then /autopilot to run the full pipeline from an approved spec',
            ],
          }),
        },
        () => runBrainstorm({
          ...(config !== undefined ? { configPath: config } : {}),
          ...(cliEngine !== undefined ? { cliEngine } : {}),
          envEngine: process.env.CLAUDE_AUTOPILOT_ENGINE,
          __silent: true,
        }),
      );
      process.exit(code);
    }
    const code = await runBrainstorm({
      ...(config !== undefined ? { configPath: config } : {}),
      ...(cliEngine !== undefined ? { cliEngine } : {}),
      envEngine: process.env.CLAUDE_AUTOPILOT_ENGINE,
    });
    process.exit(code);
    break;
  }

  case 'spec': {
    // v6.0.3 — `spec` is wrapped through `runPhase`. Same shape as
    // brainstorm: engine-off prints an advisory pointing at the Claude
    // Code skill; engine-on creates a run dir + emits lifecycle events.
    // Like brainstorm, the deviation from the spec table's
    // `idempotent: no` is justified inline at the top of src/cli/spec.ts.
    const { runSpec } = await import('./spec.ts');
    const json = boolFlag('json');
    const config = flag('config');
    const cliEngine = parseEngineCliFlag();
    if (json) {
      const code = await runUnderJsonMode(
        {
          command: 'spec',
          active: true,
          payload: () => ({
            note: 'spec is a Claude Code skill, not a CLI subcommand',
            nextActions: [
              'Approve a brainstorm output, then invoke /autopilot from Claude Code',
              'The autopilot skill writes the implementation plan + executes the pipeline',
            ],
          }),
        },
        () => runSpec({
          ...(config !== undefined ? { configPath: config } : {}),
          ...(cliEngine !== undefined ? { cliEngine } : {}),
          envEngine: process.env.CLAUDE_AUTOPILOT_ENGINE,
          __silent: true,
        }),
      );
      process.exit(code);
    }
    const code = await runSpec({
      ...(config !== undefined ? { configPath: config } : {}),
      ...(cliEngine !== undefined ? { cliEngine } : {}),
      envEngine: process.env.CLAUDE_AUTOPILOT_ENGINE,
    });
    process.exit(code);
    break;
  }

  case 'runs': {
    // v6 Phase 3 — umbrella verb. Sub-verbs: list, show, gc, delete, doctor.
    const sub = args[1];
    const json = boolFlag('json');
    const cwd = process.cwd();
    if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
      const focused = (await import('./help-text.ts')).buildCommandHelpText('runs');
      process.stdout.write(focused ?? buildHelpText());
      process.exit(0);
    }
    const {
      runRunsList,
      runRunsShow,
      runRunsGc,
      runRunsDelete,
      runRunsDoctor,
    } = await import('./runs.ts');
    let result;
    switch (sub) {
      case 'list': {
        result = await runRunsList({ cwd, status: flag('status'), json });
        break;
      }
      case 'show': {
        const events = boolFlag('events');
        const tailRaw = flag('events-tail');
        const eventsTail = tailRaw ? parseInt(tailRaw, 10) : undefined;
        // Filter out value-flag *values* — without this, `runs show
        // --events-tail 5 <ULID>` would resolve runId to '5'. Same pattern
        // as the scan case above. Caught by Cursor Bugbot on PR #88
        // (MEDIUM).
        const runId = args.slice(2).find(a =>
          !a.startsWith('--') && a !== tailRaw,
        );
        result = await runRunsShow({
          runId: runId ?? '',
          cwd,
          events,
          ...(eventsTail !== undefined ? { eventsTail } : {}),
          json,
        });
        break;
      }
      case 'gc': {
        const dryRun = boolFlag('dry-run');
        const yes = boolFlag('yes');
        const olderRaw = flag('older-than-days');
        const olderThanDays = olderRaw ? parseInt(olderRaw, 10) : undefined;
        result = await runRunsGc({
          cwd,
          dryRun,
          yes,
          ...(olderThanDays !== undefined ? { olderThanDays } : {}),
          json,
        });
        break;
      }
      case 'delete': {
        const runId = args.slice(2).find(a => !a.startsWith('--'));
        const force = boolFlag('force');
        result = await runRunsDelete({ runId: runId ?? '', cwd, force, json });
        break;
      }
      case 'doctor': {
        const runId = args.slice(2).find(a => !a.startsWith('--'));
        const fix = boolFlag('fix');
        result = await runRunsDoctor({
          cwd,
          ...(runId ? { runId } : {}),
          fix,
          json,
        });
        break;
      }
      case 'watch': {
        // v6.1 — `runs watch <id>` tails events.ndjson with a live cost meter.
        // The other umbrella verbs use a unified `RunsCliResult` shape so the
        // dispatcher can treat them uniformly; `runs-watch.ts` returns the
        // same shape.
        const sinceRaw = flag('since');
        const since = sinceRaw !== undefined ? parseInt(sinceRaw, 10) : undefined;
        if (sinceRaw !== undefined && (Number.isNaN(since) || (since as number) < 0)) {
          process.stderr.write(`\x1b[31m[claude-autopilot] --since must be a non-negative integer\x1b[0m\n`);
          process.exit(1);
        }
        const noFollow = boolFlag('no-follow');
        const noColor = boolFlag('no-color');
        // Filter the value-flag value out of the positional lookup —
        // matches the same defensive pattern used in `runs show` (Bugbot
        // PR #88 MEDIUM). Without this, `runs watch --since 5 <ULID>`
        // would resolve runId to "5".
        const runId = args.slice(2).find(a => !a.startsWith('--') && a !== sinceRaw);
        const { runRunsWatch } = await import('./runs-watch.ts');
        result = await runRunsWatch({
          runId: runId ?? '',
          cwd,
          ...(since !== undefined ? { since } : {}),
          noFollow,
          json,
          noColor,
        });
        break;
      }
      default: {
        process.stderr.write(`\x1b[31m[claude-autopilot] runs: unknown sub-verb "${sub}" — valid: list, show, gc, delete, doctor, watch\x1b[0m\n`);
        process.exit(1);
      }
    }
    for (const line of result.stdout) process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
    for (const line of result.stderr) process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
    process.exit(result.exit);
    break;
  }

  case 'run-resume': {
    // v6 Phase 3 — `run resume <id>`. Lookup-only: identifies the next phase
    // and decision rationale. Actual phase execution wires in Phase 6+.
    // The synthetic 'run-resume' subcommand was set above by the
    // disambiguation block; args[0]==='run', args[1]==='resume', args[2] is
    // optional run id.
    const json = boolFlag('json');
    const fromPhase = flag('from-phase') ?? flag('from');
    // Filter value-flag values out of positional lookup — see same comment
    // in the `runs show` case above. (Bugbot MEDIUM, PR #88.)
    const runId = args.slice(2).find(a =>
      !a.startsWith('--') && a !== fromPhase,
    );
    const { runRunResume } = await import('./runs.ts');
    const result = await runRunResume({
      runId: runId ?? '',
      cwd: process.cwd(),
      ...(fromPhase ? { fromPhase } : {}),
      json,
    });
    for (const line of result.stdout) process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
    for (const line of result.stderr) process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
    process.exit(result.exit);
    break;
  }

  case 'internal': {
    // v6 Phase 2 — hidden verb. Markdown skills shell out to append typed
    // events into a run's events.ndjson. NOT advertised in the main help.
    const { runInternalCli } = await import('../core/run-state/cli-internal.ts');
    const result = await runInternalCli({
      args: args.slice(1),
      cwd: process.cwd(),
    });
    for (const line of result.stdout) process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
    for (const line of result.stderr) process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
    process.exit(result.exit);
    break;
  }

  case 'dashboard': {
    // v7.0 Phase 2.3 — hosted dashboard verbs.
    //   claude-autopilot dashboard {login,logout,status,upload <runId>}
    const { runDashboardVerb } = await import('./dashboard/index.ts');
    const exit = await runDashboardVerb({ argv: args.slice(1) });
    process.exit(exit);
    break;
  }

  default:
    console.error(`\x1b[31m[claude-autopilot] Unknown subcommand: "${subcommand}"\x1b[0m`);
    printUsage();
    process.exit(1);
}
