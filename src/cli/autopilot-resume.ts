// src/cli/autopilot-resume.ts
//
// `cadence autopilot resume <ulid>` — inspection verb that loads the run,
// runs evidence verification, and prints what the skill harness would do
// next. Does NOT itself execute phases — the skill harness drives that.
//
// Plan: docs/superpowers/plans/2026-05-27-autopilot-run-state-integration.md

import { AutopilotRun } from '../core/autopilot/run-lifecycle.ts';
import { makeProductionProbes } from '../core/autopilot/probes.ts';

export interface AutopilotResumeOptions {
  cwd: string;
  runId: string;
  /** Test seam — inject probes for deterministic testing. */
  __probes?: ReturnType<typeof makeProductionProbes>;
}

export interface AutopilotResumeResult {
  exitCode: 0 | 1 | 2;
}

/** Run the inspection verb. Always releases the lock in a `finally` block,
 *  per codex WARNING #5. */
export async function runAutopilotResume(
  opts: AutopilotResumeOptions,
): Promise<AutopilotResumeResult> {
  const probes = opts.__probes ?? makeProductionProbes();
  const result = await AutopilotRun.resume({
    cwd: opts.cwd,
    runId: opts.runId,
    probes,
  });

  try {
    switch (result.kind) {
      case 'resumable': {
        process.stdout.write(`[autopilot] resume: run ${opts.runId}\n`);
        process.stdout.write(`  status: resumable\n`);
        process.stdout.write(`  nextPhase: ${result.nextPhase ?? '(none — run complete)'}\n`);
        process.stdout.write(`  verifications:\n`);
        for (const v of result.verifications) {
          process.stdout.write(`    ${v.phase}: ${v.kind}`);
          if (v.kind === 'must-rerun') process.stdout.write(` (${v.reason})`);
          process.stdout.write(`\n`);
        }
        process.stdout.write(`\nNOTE: phase execution is driven by the skill harness; this verb is inspection-only.\n`);
        return { exitCode: 0 };
      }
      case 'needs-human': {
        process.stderr.write(`[autopilot] resume: NEEDS HUMAN\n`);
        process.stderr.write(`  runId: ${result.runId}\n`);
        process.stderr.write(`  offendingPhase: ${result.offendingPhase}\n`);
        process.stderr.write(`  reason: ${result.reason}\n`);
        process.stderr.write(`  evidence: ${JSON.stringify(result.evidence)}\n`);
        process.stderr.write(`\n  inspect: cadence runs show ${result.runId} --events\n`);
        return { exitCode: 1 };
      }
      case 'refused': {
        process.stderr.write(`[autopilot] resume: refused (${result.reason})\n`);
        process.stderr.write(`  details: ${JSON.stringify(result.details)}\n`);
        if (result.reason === 'lock-held') return { exitCode: 2 };
        return { exitCode: 1 };
      }
      default: {
        const _exhaustive: never = result;
        void _exhaustive;
        return { exitCode: 1 };
      }
    }
  } finally {
    if (result.kind === 'resumable') {
      await result.run.release();
    }
  }
}
