import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig } from '../core/config/loader.ts';
import type { GuardrailConfig } from '../core/config/types.ts';
import { type RunPhase } from '../core/run-state/phase-runner.ts';
import { runPhaseWithLifecycle } from '../core/run-state/run-phase-with-lifecycle.ts';
import { runSchemaPolicyCheck } from '../core/schema-changes/policy-runner.ts';
import { resolveProfile } from '../core/profile/resolver.ts';
import { GuardrailError } from '../core/errors.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

export interface ValidateCommandOptions {
  cwd?: string;
  configPath?: string;
  /**
   * Optional context note injected into the validate log. The actual
   * validation work (static checks, auto-fix, tests, Codex review,
   * bugbot triage) is owned by the Claude Code `/validate` skill; this
   * CLI verb is the engine-wrap shell so v6 pipeline runs can checkpoint
   * a `validate` phase entry alongside `plan` / `review`.
   */
  context?: string;
  /**
   * Where to write the validate log file. Defaults to
   * `.guardrail-cache/validate/<timestamp>-validate.md` so it lands inside
   * the cache that's already gitignored. The path is recorded on
   * ValidateOutput so the engine path can persist it as `result` for
   * replay.
   */
  outputPath?: string;
  /**
   * v6.0.5 — engine knob inputs. Same shape and precedence as scan / costs /
   * fix / plan / review (CLI > env > config > built-in default off in
   * v6.0.x).
   */
  cliEngine?: boolean;
  envEngine?: string;
}

/**
 * Phase input — captured as a struct so the engine path's phase body matches
 * the engine-off path call signature.
 */
interface ValidateInput {
  cwd: string;
  context: string | null;
  outputPath: string;
}

/**
 * Phase output — JSON-serializable summary suitable for persistence as
 * `result` on phases/validate.json. A future skip-already-applied (Phase 6)
 * could restore this without re-running the validator by reading the
 * persisted log path.
 */
interface ValidateOutput {
  /** Absolute path to the written validate log file. */
  validateLogPath: string;
  /** Echoed for the render layer / future skip-already-applied. */
  context: string | null;
}

export async function runValidate(options: ValidateCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  let config: GuardrailConfig = { configVersion: 1 };
  if (fs.existsSync(configPath)) {
    const loaded = await loadConfig(configPath);
    if (loaded) config = loaded;
  }

  // INTENTIONAL DEVIATION FROM THE SPEC TABLE (preserved in v6.0.6):
  // the v6 spec (docs/specs/v6-run-state-engine.md, line 161) lists
  // `validate` with `idempotent: yes, hasSideEffects: no,
  // externalRefs: sarif-artifact`. This wrap declares
  // `idempotent: true, hasSideEffects: false` (matches the spec) but
  // does **not** plumb a `sarif-artifact` externalRef. The reasoning:
  // the `validate` CLI verb is an engine-wrap shell pointing at the
  // Claude Code `/validate` skill — it does not itself emit a SARIF
  // artifact. SARIF emission lives in `claude-autopilot run --format
  // sarif --output <path>` (a separate verb, see help-text.ts → `run`
  // Options block). The `sarif-artifact` externalRef is local-only file
  // output (no remote upload), so the engine doesn't need a readback
  // rule for it on resume — `idempotent: true` covers replay safety. If
  // a future PR adds SARIF emission directly to this verb (or moves the
  // `--format sarif` flag here), the wrap can add an
  // `ctx.emitExternalRef({ kind: 'sarif-artifact', id: '<path>',
  // observedAt: ... })` call after the file write lands. Until then, no
  // ledger entry is needed because there's nothing to read back from.
  const context = options.context ?? null;
  const outputPath = options.outputPath
    ? path.resolve(cwd, options.outputPath)
    : path.join(cwd, '.guardrail-cache', 'validate', `${new Date().toISOString().replace(/[:.]/g, '-')}-validate.md`);

  const validateInput: ValidateInput = { cwd, context, outputPath };

  // The wrapped phase body — writes a validate log stub to disk. The actual
  // validation work (static checks → auto-fix → tests → Codex review →
  // bugbot triage) is produced by the Claude Code `/validate` skill.
  // Engine-off callers invoke this directly via `executeValidatePhase()`;
  // engine-on callers route through `runPhase()`.
  const phase: RunPhase<ValidateInput, ValidateOutput> = {
    name: 'validate',
    // Re-running the validate verb against the same context writes the same
    // log file. Engine treats local file writes as overwrite-style — same
    // precedent as scan's findings-cache and review's review-log.
    idempotent: true,
    // Local file write only — no PR comment posting, no git push, no
    // provider-side mutation, no SARIF upload. See the long deviation note
    // above where the engine resolution is computed for the externalRefs
    // rationale.
    hasSideEffects: false,
    run: async input => executeValidatePhase(input),
  };

  // v6.0.6 — lifecycle wiring lives in `runPhaseWithLifecycle`.
  let output: ValidateOutput;
  try {
    const result = await runPhaseWithLifecycle<ValidateInput, ValidateOutput>({
      cwd,
      phase,
      input: validateInput,
      config,
      cliEngine: options.cliEngine,
      envEngine: options.envEngine,
      runEngineOff: () => executeValidatePhase(validateInput),
    });
    output = result.output;
  } catch {
    return 1;
  }

  // v8.6 — enforce schema-change policy on the most recent implement
  // artifact when the profile opts in. Best-effort: errors are surfaced
  // but never crash the verb; the verdict is appended to the validate log.
  try {
    const policyResult = await enforceSchemaChangePolicyForCwd(cwd);
    if (!policyResult.ok) {
      const lines = ['', '## Schema-change policy violations', ''];
      for (const issue of policyResult.issues) {
        lines.push(`- [${issue.severity}] ${issue.code}: ${issue.message}`);
      }
      fs.appendFileSync(output.validateLogPath, lines.join('\n') + '\n', 'utf8');
      // Print to stderr too.
      for (const line of lines) process.stderr.write(line + '\n');
      // Throw a typed error so the caller's exit code reflects the block.
      throw new GuardrailError(
        `schema-change policy violations (${policyResult.issues.length})`,
        { code: 'schema_policy_violation', provider: 'validate', details: { issues: policyResult.issues } },
      );
    }
  } catch (err) {
    if (err instanceof GuardrailError && err.code === 'schema_policy_violation') {
      return 1;
    }
    // Non-blocking failures from the policy check itself — log and continue.
    process.stderr.write(`[validate] schema policy check skipped: ${(err as Error).message}\n`);
  }

  return renderValidateOutput(output, validateInput);
}

/**
 * v8.6 — read the latest implement artifact + the resolved profile, then
 * run enforcePolicy. Returns `{ ok: true, issues: [] }` when no profile,
 * no opt-in, or no artifact. Errors thrown by the resolver are swallowed
 * to keep validate non-blocking on profile-resolution edge cases.
 */
async function enforceSchemaChangePolicyForCwd(cwd: string): Promise<{ ok: boolean; issues: Awaited<ReturnType<typeof runSchemaPolicyCheck>>['issues'] }> {
  let schemaPaths: string[] = [];
  let policy: import('../core/profile/types.ts').SchemaChangePolicy | undefined;
  try {
    const resolved = await resolveProfile({ cwd });
    schemaPaths = resolved.config.schemaPaths ?? [];
    policy = resolved.config.schemaChangePolicy;
  } catch {
    return { ok: true, issues: [] };
  }
  if (schemaPaths.length === 0) return { ok: true, issues: [] };
  const runDir = findLatestRunDir(cwd);
  if (!runDir) return { ok: true, issues: [] };
  const opts: Parameters<typeof runSchemaPolicyCheck>[0] = { runDir };
  if (policy) opts.policy = policy;
  const r = await runSchemaPolicyCheck(opts);
  return { ok: r.ok, issues: r.issues };
}

function findLatestRunDir(cwd: string): string | null {
  const runsRoot = path.join(cwd, '.claude', 'autopilot', 'runs');
  if (!fs.existsSync(runsRoot)) return null;
  try {
    const entries = fs.readdirSync(runsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, mtime: fs.statSync(path.join(runsRoot, d.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (entries.length === 0) return null;
    return path.join(runsRoot, entries[0]!.name);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase body — write a validate log stub. Pure: no console output, no exit
// codes. Returns a JSON-serializable ValidateOutput so the engine can persist
// it as `result` on the phase snapshot. The actual validation work is
// produced by the Claude Code `/validate` skill; this CLI verb's job is to
// provide a checkpointable phase shell.
// ---------------------------------------------------------------------------

async function executeValidatePhase(input: ValidateInput): Promise<ValidateOutput> {
  const { context, outputPath } = input;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const lines = [
    '# Validate',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    context ? `Context: ${context}` : 'Context: (none provided)',
    '',
    '<!--',
    'This is the v6 engine-wrap stub for the `validate` phase. The actual',
    'validation work (static checks, auto-fix, tests, Codex review with',
    'auto-fix, bugbot triage) is produced by the Claude Code `/validate`',
    'skill. The CLI verb exists to provide a checkpointable phase shell so',
    '`claude-autopilot runs show <id>` reflects a `validate` phase entry',
    'when the pipeline includes one. SARIF emission lives in',
    '`claude-autopilot run --format sarif --output <path>` (a separate',
    'verb).',
    '-->',
    '',
  ];
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');

  return {
    validateLogPath: outputPath,
    context,
  };
}

// ---------------------------------------------------------------------------
// Render — translate ValidateOutput back to a stdout summary + exit code.
// Lives outside the wrapped phase because it's pure presentation.
// ---------------------------------------------------------------------------

function renderValidateOutput(output: ValidateOutput, input: ValidateInput): number {
  const { validateLogPath, context } = output;
  const { cwd } = input;

  console.log('');
  console.log(fmt('bold', '[validate]') + ' ' + fmt('dim', context ? `context: ${context}` : 'no context provided'));
  console.log(fmt('dim', `  → ${path.relative(cwd, validateLogPath)}`));
  console.log('');
  console.log(fmt('cyan', 'Note:') + fmt('dim', ' the validation pipeline lives in Claude Code (/validate skill —'));
  console.log(fmt('dim', '       static checks, auto-fix, tests, Codex review, bugbot triage).'));
  console.log(fmt('dim', '       SARIF emission lives in `claude-autopilot run --format sarif --output <path>`.'));
  console.log('');
  return 0;
}
