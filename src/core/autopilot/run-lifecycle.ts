// src/core/autopilot/run-lifecycle.ts
//
// AutopilotRun — the lifecycle wrapper the skill harness calls at each
// phase boundary. Sits ON TOP of the existing v6 run-state primitives
// (no duplication). Surfaces a typed API for create / resume / beginPhase
// / endPhase / failPhase / release.
//
// Spec: docs/superpowers/specs/2026-05-27-autopilot-run-state-integration-design.md
// Plan: docs/superpowers/plans/2026-05-27-autopilot-run-state-integration.md

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { GuardrailError } from '../errors.ts';
import { createRun, runDirFor } from '../run-state/runs.ts';
import {
  acquireRunLock,
  peekLockOwner,
  isPidAlive,
  type RunLockHandle,
} from '../run-state/lock.ts';
import type { WriterId } from '../run-state/types.ts';
import { appendEvent, readEvents } from '../run-state/events.ts';
import {
  readStateSnapshot,
  writeStateSnapshot,
  recoverState,
} from '../run-state/state.ts';
import type { RunState } from '../run-state/types.ts';
import {
  SKILL_PHASES,
  PHASE_CONTRACTS,
  validatePhaseOutput,
  validateAutopilotRunConfig,
  isMajorCompatible,
  type SkillPhaseName,
  type AutopilotPhaseOutputs,
  type AutopilotRunConfig,
} from './run-state-schema.ts';
import {
  verifyPhaseEvidence,
  type VerifierProbes,
  type PhaseVerificationResult,
} from './resume-verifier.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** A lock is considered stale after this many ms with no heartbeat. */
export const STALE_LOCK_TIMEOUT_MS = 600_000; // 10 minutes

/** Heartbeat refresh interval during an active phase. */
export const PHASE_HEARTBEAT_INTERVAL_MS = 60_000;

const HEARTBEAT_FILE = '.lock-heartbeat.json';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PhaseInput<P extends SkillPhaseName> = Record<string, unknown>;
export type PhaseOutput<P extends SkillPhaseName> = NonNullable<AutopilotPhaseOutputs[P]>;

export interface AutopilotCreateOpts {
  cwd: string;
  specPath: string;
  cadenceVersion: string;
  argv: readonly string[];
  featureFlags: Record<string, boolean>;
  profile: string;
  profileSnapshot: Record<string, unknown>;
  worktreePath?: string;
  branch?: string;
  baseSha?: string;
  /** Test seam — inject a WriterId. */
  __writerIdOverride?: WriterId;
  /** Test seam — override Date.now() for deterministic heartbeat tests. */
  __clock?: () => number;
  /** Test seam — force-enable creation even when env flag is off. */
  __forceEnable?: boolean;
}

export interface ResumeOpts {
  cwd: string;
  runId: string;
  /** Probes to use for evidence verification. Production callers pass
   *  the result of `makeProductionProbes()`; tests inject stubs. */
  probes: VerifierProbes;
  __writerIdOverride?: WriterId;
  __clock?: () => number;
}

export type ResumeResult =
  | { kind: 'resumable'; run: AutopilotRun; nextPhase: SkillPhaseName | null; verifications: PhaseVerificationResult[] }
  | { kind: 'needs-human'; runDir: string; runId: string; reason: string; offendingPhase: SkillPhaseName; evidence: Record<string, unknown> }
  | { kind: 'refused'; reason: 'flag-was-off' | 'schema-major-mismatch' | 'lock-held' | 'not-found' | 'corrupted'; details: Record<string, unknown> };

// ---------------------------------------------------------------------------
// AutopilotRun class
// ---------------------------------------------------------------------------

export class AutopilotRun {
  private constructor(
    private readonly _runId: string,
    private readonly _runDir: string,
    private readonly _cwd: string,
    private readonly lock: RunLockHandle,
    private _state: RunState,
    private readonly clock: () => number,
  ) {}

  // -------- Static factories --------

  static async create(opts: AutopilotCreateOpts): Promise<AutopilotRun> {
    const envFlag = process.env.CADENCE_RUN_STATE_ENABLED === 'true';
    if (!envFlag && !opts.__forceEnable) {
      throw new GuardrailError(
        'AutopilotRun.create: CADENCE_RUN_STATE_ENABLED must be "true"',
        { code: 'invalid_config', provider: 'autopilot-run-lifecycle' },
      );
    }
    const clock = opts.__clock ?? Date.now;

    // Build the AutopilotRunConfig blob that will live in state.config.
    const cfg: AutopilotRunConfig = {
      cadenceVersion: opts.cadenceVersion,
      argv: opts.argv,
      createdByCommand: 'autopilot',
      featureFlags: { ...opts.featureFlags, CADENCE_RUN_STATE_ENABLED: true },
      specPath: opts.specPath,
      repoRoot: opts.cwd,
      profile: opts.profile,
      profileSnapshot: opts.profileSnapshot,
      phaseOutputs: {},
      ...(opts.worktreePath !== undefined ? { worktreePath: opts.worktreePath } : {}),
      ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
      ...(opts.baseSha !== undefined ? { baseSha: opts.baseSha } : {}),
    };

    const created = await createRun({
      cwd: opts.cwd,
      phases: [...SKILL_PHASES],
      config: cfg as unknown as Record<string, unknown>,
    });

    // The createRun helper may not use our writerId override directly,
    // but createRun returns its own lock; if test wants to override, the
    // standard pattern is to release createRun's lock and re-acquire
    // with the override. For unit tests we accept the production lock
    // since they don't actually fork.
    void opts.__writerIdOverride;

    writeHeartbeat(created.runDir, clock());

    return new AutopilotRun(
      created.runId,
      created.runDir,
      opts.cwd,
      created.lock,
      created.state,
      clock,
    );
  }

  static async resume(opts: ResumeOpts): Promise<ResumeResult> {
    const clock = opts.__clock ?? Date.now;
    const runDir = runDirFor(opts.cwd, opts.runId);

    if (!fs.existsSync(runDir)) {
      return { kind: 'refused', reason: 'not-found', details: { runId: opts.runId, runDir } };
    }

    // Try to read state; fall back to events replay if needed.
    let state: RunState;
    try {
      const snap = readStateSnapshot(runDir);
      if (snap) {
        state = snap;
      } else {
        // Recovery requires a writerId; use a synthetic one for replay.
        // We re-acquire below; the recovery path's index.rebuilt event
        // gets stamped with this temporary id, which is acceptable.
        const tempLock = await acquireRunLock(runDir);
        try {
          state = recoverState(runDir, { writerId: tempLock.writerId, runId: opts.runId }).state;
        } finally {
          await tempLock.release();
        }
      }
    } catch (err) {
      return {
        kind: 'refused',
        reason: 'corrupted',
        details: { error: (err as Error).message },
      };
    }

    // Validate the AutopilotRunConfig blob.
    const cfgValidation = validateAutopilotRunConfig(state.config);
    if (!cfgValidation.ok) {
      return {
        kind: 'refused',
        reason: 'corrupted',
        details: { configError: cfgValidation.error },
      };
    }
    const cfg = cfgValidation.value;

    // Schema major-version check.
    // We compare against the runtime binary's own version. Read from
    // package.json at this module's repo root.
    const binaryVersion = readBinaryCadenceVersion();
    if (!isMajorCompatible(cfg.cadenceVersion, binaryVersion)) {
      return {
        kind: 'refused',
        reason: 'schema-major-mismatch',
        details: { stateVersion: cfg.cadenceVersion, binaryVersion },
      };
    }

    // Feature-flag-was-off check.
    if (cfg.featureFlags.CADENCE_RUN_STATE_ENABLED !== true) {
      return {
        kind: 'refused',
        reason: 'flag-was-off',
        details: { featureFlags: cfg.featureFlags },
      };
    }

    // Stale-lock detection (uses lastHeartbeatAt, NOT acquiredAt).
    const owner = peekLockOwner(runDir);
    const heartbeat = readHeartbeat(runDir);
    if (owner) {
      const lastHb = heartbeat ?? Date.parse(owner.acquiredAt);
      const ageMs = clock() - lastHb;
      const alive = isPidAlive(owner.writerId);
      if (alive && ageMs < STALE_LOCK_TIMEOUT_MS) {
        return {
          kind: 'refused',
          reason: 'lock-held',
          details: {
            owner: owner.writerId,
            acquiredAt: owner.acquiredAt,
            lastHeartbeatAt: heartbeat,
            hint: 'wait for the active run to finish, or use `cadence runs cleanup --force-unlock <runId>` after confirming the process is gone',
          },
        };
      }
      // Stale — fall through to acquire (proper-lockfile's stale support
      // will allow it; if not, the acquire will fail with lock_held
      // anyway).
    }

    // Acquire lock.
    let lock: RunLockHandle;
    try {
      lock = await acquireRunLock(runDir);
    } catch (err) {
      return {
        kind: 'refused',
        reason: 'lock-held',
        details: { error: (err as Error).message },
      };
    }

    // Refresh heartbeat to mark this writer alive.
    writeHeartbeat(runDir, clock());

    // Check for orphaned phase.success events — codex WARNING #4.
    const orphan = detectOrphanedPhaseSuccess(runDir, cfg.phaseOutputs);
    if (orphan) {
      await lock.release();
      return {
        kind: 'needs-human',
        runDir,
        runId: opts.runId,
        reason: 'orphaned phase.success event detected (state.json was not written after side effect)',
        offendingPhase: orphan.phase,
        evidence: { orphanedPhase: orphan.phase, seq: orphan.seq },
      };
    }

    // Verify each completed phase against external evidence.
    const verifications: PhaseVerificationResult[] = [];
    const verifyCtx: {
      repoRoot: string;
      worktreePath?: string;
      prNumber?: number;
      probes: VerifierProbes;
    } = {
      repoRoot: cfg.repoRoot,
      probes: opts.probes,
    };
    if (cfg.worktreePath !== undefined) verifyCtx.worktreePath = cfg.worktreePath;
    // We may discover the worktreePath / prNumber from earlier verified
    // phases; update verifyCtx as we go.
    let nextPhase: SkillPhaseName | null = null;
    for (const phase of SKILL_PHASES) {
      const out = cfg.phaseOutputs[phase];
      if (out === undefined) {
        nextPhase = phase;
        break;
      }
      // Update ctx with values from earlier completed phases.
      if (phase === 'worktree') {
        verifyCtx.worktreePath = (out as { path: string }).path;
      } else if (phase === 'pr') {
        verifyCtx.prNumber = (out as { number: number }).number;
      }
      const res = await verifyPhaseEvidence(phase, out, verifyCtx);
      verifications.push(res);
      if (res.kind === 'needs-human') {
        await lock.release();
        return {
          kind: 'needs-human',
          runDir,
          runId: opts.runId,
          reason: res.reason,
          offendingPhase: phase,
          evidence: res.evidence,
        };
      }
      if (res.kind === 'must-rerun') {
        nextPhase = phase;
        break;
      }
      // verified-applied — keep advancing
    }

    const run = new AutopilotRun(opts.runId, runDir, opts.cwd, lock, state, clock);
    return { kind: 'resumable', run, nextPhase, verifications };
  }

  // -------- Accessors --------

  get runId(): string {
    return this._runId;
  }

  get runDir(): string {
    return this._runDir;
  }

  get currentPhase(): SkillPhaseName {
    // Compute from the state — first phase without phaseOutputs entry.
    const cfg = this.getCfg();
    for (const p of SKILL_PHASES) {
      if (cfg.phaseOutputs[p] === undefined) return p;
    }
    return 'merge';
  }

  // -------- Lifecycle --------

  async beginPhase<P extends SkillPhaseName>(phase: P, _input: PhaseInput<P>): Promise<void> {
    const phaseIdx = SKILL_PHASES.indexOf(phase);
    if (phaseIdx < 0) {
      throw new GuardrailError(`unknown phase: ${phase}`, {
        code: 'invalid_config',
        provider: 'autopilot-run-lifecycle',
      });
    }
    const contract = PHASE_CONTRACTS[phase];
    // Count prior attempts of this phase in events.
    const attempt = countPhaseAttempts(this._runDir, phase) + 1;
    appendEvent(
      this._runDir,
      {
        event: 'phase.start',
        phase,
        phaseIdx,
        idempotent: contract.idempotent,
        hasSideEffects: contract.hasSideEffects,
        attempt,
      },
      { writerId: this.lock.writerId, runId: this._runId },
    );
    writeHeartbeat(this._runDir, this.clock());
  }

  async endPhase<P extends SkillPhaseName>(phase: P, output: PhaseOutput<P>): Promise<void> {
    const validation = validatePhaseOutput(phase, output);
    if (!validation.ok) {
      throw new GuardrailError(`endPhase: ${validation.error}`, {
        code: 'invalid_config',
        provider: 'autopilot-run-lifecycle',
      });
    }
    const validated = validation.value;
    const phaseIdx = SKILL_PHASES.indexOf(phase);

    // Codex WARNING #4 fix: persist the full validated output as an
    // artifact alongside the event so resume can reconstruct
    // state.config.phaseOutputs even if state.json write fails after
    // the event lands.
    const artifactRelPath = writePhaseOutputArtifact(this._runDir, phase, validated);
    const startTs = findPhaseStartTs(this._runDir, phase) ?? this.clock();
    const durationMs = Math.max(0, this.clock() - startTs);

    // Atomic durability barrier: append event FIRST (fsync'd), then
    // refresh state.json. If state.json write fails, the event log has
    // the artifact pointer — resume() reconstructs from disk.
    try {
      appendEvent(
        this._runDir,
        {
          event: 'phase.success',
          phase,
          phaseIdx,
          durationMs,
          artifacts: [
            {
              name: '__autopilot_output__',
              path: artifactRelPath,
            },
          ],
        },
        { writerId: this.lock.writerId, runId: this._runId },
      );
    } catch (err) {
      throw new GuardrailError(
        `endPhase: failed to append phase.success event: ${(err as Error).message}`,
        { code: 'corrupted_state', provider: 'autopilot-run-lifecycle' },
      );
    }

    // Refresh state.json with the new phaseOutput.
    const cfg = this.getCfg();
    const newCfg: AutopilotRunConfig = {
      ...cfg,
      phaseOutputs: { ...cfg.phaseOutputs, [phase]: validated },
    };
    const newState: RunState = {
      ...this._state,
      config: newCfg as unknown as Record<string, unknown>,
    };
    try {
      writeStateSnapshot(this._runDir, newState);
      this._state = newState;
    } catch (err) {
      throw new GuardrailError(
        `endPhase: failed to write state.json after phase.success — durability barrier failed: ${(err as Error).message}`,
        { code: 'corrupted_state', provider: 'autopilot-run-lifecycle' },
      );
    }
    writeHeartbeat(this._runDir, this.clock());
  }

  async failPhase(phase: SkillPhaseName, err: Error, hint: 'retry' | 'needs-human'): Promise<void> {
    const phaseIdx = SKILL_PHASES.indexOf(phase);
    const startTs = findPhaseStartTs(this._runDir, phase) ?? this.clock();
    const durationMs = Math.max(0, this.clock() - startTs);
    if (hint === 'needs-human') {
      appendEvent(
        this._runDir,
        {
          event: 'phase.needs-human',
          phase,
          phaseIdx,
          reason: err.message,
          nextActions: ['inspect via `cadence runs show <runId> --events`'],
        },
        { writerId: this.lock.writerId, runId: this._runId },
      );
    } else {
      appendEvent(
        this._runDir,
        {
          event: 'phase.failed',
          phase,
          phaseIdx,
          durationMs,
          error: err.message,
        },
        { writerId: this.lock.writerId, runId: this._runId },
      );
    }
    writeHeartbeat(this._runDir, this.clock());
  }

  async release(): Promise<void> {
    await this.lock.release().catch(() => { /* idempotent */ });
  }

  // -------- internals --------

  private getCfg(): AutopilotRunConfig {
    const v = validateAutopilotRunConfig(this._state.config);
    if (!v.ok) {
      throw new GuardrailError(
        `state.config invalid: ${v.error}`,
        { code: 'corrupted_state', provider: 'autopilot-run-lifecycle' },
      );
    }
    return v.value;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writePhaseOutputArtifact(
  runDir: string,
  phase: SkillPhaseName,
  output: unknown,
): string {
  const artifactsDir = path.join(runDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const relPath = path.join('artifacts', `${phase}.json`);
  const absPath = path.join(runDir, relPath);
  const data = JSON.stringify(output, null, 2);
  // Use a temp + rename for atomicity, like writeStateSnapshot does.
  const tmp = absPath + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, absPath);
  return relPath;
}

function readPhaseOutputArtifact(runDir: string, phase: SkillPhaseName): unknown | null {
  const p = path.join(runDir, 'artifacts', `${phase}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeHeartbeat(runDir: string, ts: number): void {
  try {
    fs.writeFileSync(
      path.join(runDir, HEARTBEAT_FILE),
      JSON.stringify({ lastHeartbeatAt: ts }, null, 2),
      'utf8',
    );
  } catch {
    // best-effort
  }
}

function readHeartbeat(runDir: string): number | null {
  const p = path.join(runDir, HEARTBEAT_FILE);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { lastHeartbeatAt?: number };
    return typeof raw.lastHeartbeatAt === 'number' ? raw.lastHeartbeatAt : null;
  } catch {
    return null;
  }
}

function countPhaseAttempts(runDir: string, phase: SkillPhaseName): number {
  try {
    const { events } = readEvents(runDir);
    return events.filter(e => e.event === 'phase.start' && (e as { phase?: string }).phase === phase).length;
  } catch {
    return 0;
  }
}

function findPhaseStartTs(runDir: string, phase: SkillPhaseName): number | null {
  try {
    const { events } = readEvents(runDir);
    // Find the most recent phase.start for this phase that doesn't have
    // a matching success/failed/needs-human after it.
    let lastStart: number | null = null;
    for (const ev of events) {
      if ((ev as { phase?: string }).phase !== phase) continue;
      if (ev.event === 'phase.start') {
        const t = Date.parse(ev.ts);
        if (Number.isFinite(t)) lastStart = t;
      }
    }
    return lastStart;
  } catch {
    return null;
  }
}

interface OrphanInfo {
  phase: SkillPhaseName;
  seq: number;
}

/** Detect orphaned phase.success events — codex WARNING #4 fix. Returns
 *  null if events log and phaseOutputs agree; otherwise the offending
 *  phase. Tries to recover from the artifact file before declaring
 *  orphan. */
function detectOrphanedPhaseSuccess(
  runDir: string,
  phaseOutputs: AutopilotPhaseOutputs,
): OrphanInfo | null {
  let events;
  try {
    events = readEvents(runDir).events;
  } catch {
    return null;
  }
  for (const ev of events) {
    if (ev.event !== 'phase.success') continue;
    const phase = (ev as { phase?: string }).phase as SkillPhaseName | undefined;
    if (!phase || !(SKILL_PHASES as readonly string[]).includes(phase)) continue;
    if (phaseOutputs[phase] !== undefined) continue;
    // state.json lacks the output. Try to recover from the artifact.
    const recovered = readPhaseOutputArtifact(runDir, phase);
    if (recovered !== null) {
      const v = validatePhaseOutput(phase, recovered);
      if (v.ok) {
        // Re-populate phaseOutputs in-memory so verification can use it.
        (phaseOutputs as Record<string, unknown>)[phase] = v.value;
        continue;
      }
    }
    return { phase, seq: (ev as { seq: number }).seq };
  }
  return null;
}

function readBinaryCadenceVersion(): string {
  // Walk up from this file to find package.json. Cached so repeated calls
  // don't re-stat.
  if (cachedBinaryVersion) return cachedBinaryVersion;
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 10; i++) {
    const p = path.join(dir, 'package.json');
    if (fs.existsSync(p)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { name?: string; version?: string };
        if (pkg.name && pkg.version && (pkg.name === '@delegance/cadence' || pkg.name === '@delegance/claude-autopilot')) {
          cachedBinaryVersion = pkg.version;
          return pkg.version;
        }
      } catch {
        // ignore
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedBinaryVersion = '0.0.0';
  return cachedBinaryVersion;
}
let cachedBinaryVersion: string | null = null;

// Suppress unused warning — crypto is imported for future canonicalization
// of artifact payloads. Currently we JSON.stringify with indent=2.
void crypto;
