// Type re-exports (v6 era).
export type { Finding, Severity, FindingSource } from './core/findings/types.js';
export type { RunResult, RunInput, PhaseResult } from './core/pipeline/run.js';
export type { GuardrailConfig, AdapterRef, AdapterReference } from './core/config/types.js';

// v7.3.0 — Curated library API for in-process consumers (notably the v8
// daemon, which imports these instead of spawning the CLI subprocess).
//
// ## Stability contract
//
// Anything re-exported below is part of the supported library API. Changes
// to function signatures here are SemVer-major. Internal refactors that
// don't change the exported shape are SemVer-minor or patch.
//
// Functions deliberately NOT re-exported (still callable via direct
// `@delegance/cadence/cli/*` imports if you really need them, but
// no compatibility guarantee):
//   - JSON-envelope wrappers (`runUnderJsonMode`, `runAutopilotWithJsonEnvelope`)
//     — those are CLI-shape helpers, not library shape.
//   - Internal `_*` helpers and test seams.
//   - The `runs` / `runs-watch` group — engine introspection is a separate
//     daemon prerequisite (`@delegance/cadence/run-state` will export
//     it once it's stable).
//
// See docs/library-api.md for the full surface + usage examples.

// Pipeline verbs (read-only / discovery).
export { runScan } from './cli/scan.js';
export { runScaffold } from './cli/scaffold.js';
export { runValidate } from './cli/validate.js';
export { runFix } from './cli/fix.js';
export { runCosts } from './cli/costs.js';
export { runReport } from './cli/report.js';
export { runDoctor } from './cli/preflight.js';
export { runSetup } from './cli/setup.js';

// Pipeline verbs (side-effecting — daemon must wrap these in policy gates).
export { runDeploy, runDeployStatus, runDeployRollback } from './cli/deploy.js';

// Helpers.
export { detectProject } from './cli/detector.js';
export type { DetectionResult } from './cli/detector.js';

// Scaffold types — useful when consumers want to typecheck arguments.
export type { ScaffoldOptions, ScaffoldResult } from './cli/scaffold.js';
export type { SetupOptions, ProfileName } from './cli/setup.js';
