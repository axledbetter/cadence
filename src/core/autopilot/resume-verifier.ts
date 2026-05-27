// src/core/autopilot/resume-verifier.ts
//
// Per-phase external-evidence verification. Pure functions taking
// `phaseOutputs[phase]` + a small set of injectable probes (filesystem,
// git, gh, supabase). The probes are passed in by the caller so tests can
// stub them.
//
// Spec: docs/superpowers/specs/2026-05-27-autopilot-run-state-integration-design.md
// Plan: docs/superpowers/plans/2026-05-27-autopilot-run-state-integration.md

import type {
  SkillPhaseName,
  SpecPhaseOutput,
  PlanPhaseOutput,
  WorktreePhaseOutput,
  ImplementPhaseOutput,
  MigratePhaseOutput,
  ValidatePhaseOutput,
  PrPhaseOutput,
  CodexPhaseOutput,
  BugbotPhaseOutput,
  MergePhaseOutput,
} from './run-state-schema.ts';

// ---------------------------------------------------------------------------
// Probe interface — injected by caller
// ---------------------------------------------------------------------------

export interface VerifierProbes {
  /** Returns true iff the path exists and is a regular file. */
  fileExists(path: string): boolean;
  /** Returns "sha256:<64-hex>" of the file contents. Throws on read error. */
  fileSha(path: string): string;
  /** Returns the list of worktrees known to git for the given repo. */
  gitWorktreeList(repoRoot: string): { path: string; branch: string }[];
  /** Returns the 40-hex commit SHA at HEAD of the given worktree. */
  gitRevParseHead(worktreePath: string): string;
  /** Returns `git status --porcelain=v2` output (empty string = clean). */
  gitStatusPorcelain(worktreePath: string): string;
  /** Checks the cadence migration log table for a migration id. */
  migrationLogContains(id: string): Promise<{ found: boolean; checksum?: string }>;
  /** `gh pr view <num>` result, or null if PR doesn't exist. */
  ghPrView(num: number): Promise<{ headRefName: string; mergedAt: string | null } | null>;
  /** Checks whether a PR review-comment id exists on the named PR. */
  ghPrComment(prNumber: number, commentId: string): Promise<{ exists: boolean }>;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type PhaseVerificationResult =
  | { kind: 'verified-applied'; phase: SkillPhaseName }
  | { kind: 'must-rerun'; phase: SkillPhaseName; reason: string }
  | { kind: 'needs-human'; phase: SkillPhaseName; reason: string; evidence: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Per-phase verifiers
// ---------------------------------------------------------------------------

function verifyFileEvidence(
  phase: 'spec' | 'plan',
  output: SpecPhaseOutput | PlanPhaseOutput,
  repoRoot: string,
  probes: VerifierProbes,
): PhaseVerificationResult {
  // Resolve repo-relative paths against repoRoot.
  const abs = output.path.startsWith('/') ? output.path : `${repoRoot}/${output.path}`;
  if (!probes.fileExists(abs)) {
    return {
      kind: 'needs-human',
      phase,
      reason: `${phase} file no longer exists at recorded path`,
      evidence: { path: output.path, abs },
    };
  }
  let currentSha: string;
  try {
    currentSha = probes.fileSha(abs);
  } catch (err) {
    return {
      kind: 'needs-human',
      phase,
      reason: `cannot read ${phase} file: ${(err as Error).message}`,
      evidence: { path: output.path },
    };
  }
  if (currentSha !== output.sha) {
    return {
      kind: 'needs-human',
      phase,
      reason: `${phase} file content sha mismatch (hand-edited?)`,
      evidence: { expected: output.sha, actual: currentSha },
    };
  }
  return { kind: 'verified-applied', phase };
}

function verifyWorktree(
  output: WorktreePhaseOutput,
  repoRoot: string,
  probes: VerifierProbes,
): PhaseVerificationResult {
  const worktrees = probes.gitWorktreeList(repoRoot);
  const match = worktrees.find(w => w.path === output.path);
  if (!match) {
    return {
      kind: 'needs-human',
      phase: 'worktree',
      reason: 'recorded worktree no longer registered with git',
      evidence: { recordedPath: output.path, knownWorktrees: worktrees },
    };
  }
  if (match.branch !== output.branch) {
    return {
      kind: 'needs-human',
      phase: 'worktree',
      reason: 'worktree branch changed since recording',
      evidence: { expected: output.branch, actual: match.branch },
    };
  }
  return { kind: 'verified-applied', phase: 'worktree' };
}

function verifyImplement(
  output: ImplementPhaseOutput,
  probes: VerifierProbes,
): PhaseVerificationResult {
  // We need the worktree path to query git; pull it from the run config —
  // the caller passes it in via the probes layer (worktree was already
  // verified, so its path is stable).
  // For this verifier the caller has already verified worktree; we accept
  // the assumption and re-derive head from the recorded headSha against
  // git's current HEAD via the probe.
  // We don't have worktreePath here; caller must pass it. To keep the
  // signature stable, callers must verify worktree FIRST, then look up
  // the path from output.worktree.path and pass it in via a curried probe.
  // To avoid that coupling we instead require the caller to provide
  // implementWorktreePath via a parameter (see verifyPhaseEvidence wrapper).
  void output; void probes;
  throw new Error('verifyImplement must be called via verifyPhaseEvidence which passes worktreePath');
}

function verifyImplementWithPath(
  output: ImplementPhaseOutput,
  worktreePath: string,
  probes: VerifierProbes,
): PhaseVerificationResult {
  let head: string;
  try {
    head = probes.gitRevParseHead(worktreePath);
  } catch (err) {
    return {
      kind: 'needs-human',
      phase: 'implement',
      reason: `cannot read worktree HEAD: ${(err as Error).message}`,
      evidence: { worktreePath },
    };
  }
  if (head !== output.headSha) {
    return {
      kind: 'needs-human',
      phase: 'implement',
      reason: 'worktree HEAD diverged from recorded headSha',
      evidence: { expected: output.headSha, actual: head },
    };
  }
  let porcelain: string;
  try {
    porcelain = probes.gitStatusPorcelain(worktreePath);
  } catch (err) {
    return {
      kind: 'needs-human',
      phase: 'implement',
      reason: `cannot read worktree status: ${(err as Error).message}`,
      evidence: { worktreePath },
    };
  }
  if (porcelain.length > 0) {
    return {
      kind: 'needs-human',
      phase: 'implement',
      reason: 'worktree is dirty at resume time',
      evidence: { porcelain },
    };
  }
  return { kind: 'verified-applied', phase: 'implement' };
}

async function verifyMigrate(
  output: MigratePhaseOutput,
  probes: VerifierProbes,
): Promise<PhaseVerificationResult> {
  // Codex CRITICAL #2 — until the cadence_migration_log table exists,
  // probes.migrationLogContains() returns { found: false } for every id,
  // and we route to needs-human. We NEVER auto-rerun a migration on
  // resume, and we NEVER auto-skip without verifiable evidence.
  if (output.appliedMigrations.length === 0) {
    return { kind: 'verified-applied', phase: 'migrate' };
  }
  for (const m of output.appliedMigrations) {
    const r = await probes.migrationLogContains(m.id);
    if (!r.found) {
      return {
        kind: 'needs-human',
        phase: 'migrate',
        reason:
          'migration verification not yet available — the cadence migration log table is required to safely resume past a completed migrate phase. ' +
          'Inspect manually, then re-run with --force-replay, or wait for the migration-log PR to land.',
        evidence: { migrationId: m.id },
      };
    }
    if (r.checksum !== undefined && r.checksum !== m.checksum) {
      return {
        kind: 'needs-human',
        phase: 'migrate',
        reason: 'migration checksum mismatch',
        evidence: { id: m.id, expected: m.checksum, actual: r.checksum },
      };
    }
  }
  return { kind: 'verified-applied', phase: 'migrate' };
}

function verifyValidate(
  output: ValidatePhaseOutput,
  repoRoot: string,
  probes: VerifierProbes,
): PhaseVerificationResult {
  if (output.verdict !== 'pass') {
    return {
      kind: 'must-rerun',
      phase: 'validate',
      reason: 'last validate failed; re-run to re-check',
    };
  }
  const abs = output.reportPath.startsWith('/')
    ? output.reportPath
    : `${repoRoot}/${output.reportPath}`;
  if (!probes.fileExists(abs)) {
    return {
      kind: 'must-rerun',
      phase: 'validate',
      reason: 'validation report missing — re-run to regenerate',
    };
  }
  let currentSha: string;
  try {
    currentSha = probes.fileSha(abs);
  } catch {
    return {
      kind: 'must-rerun',
      phase: 'validate',
      reason: 'cannot read validation report — re-run to regenerate',
    };
  }
  if (currentSha !== output.reportSha) {
    return {
      kind: 'must-rerun',
      phase: 'validate',
      reason: 'validation report sha mismatch — stale; re-run',
    };
  }
  return { kind: 'verified-applied', phase: 'validate' };
}

async function verifyPr(
  output: PrPhaseOutput,
  probes: VerifierProbes,
): Promise<PhaseVerificationResult> {
  const view = await probes.ghPrView(output.number);
  if (!view) {
    return {
      kind: 'needs-human',
      phase: 'pr',
      reason: 'PR not found on GitHub',
      evidence: { number: output.number },
    };
  }
  if (view.headRefName !== output.headRef) {
    return {
      kind: 'needs-human',
      phase: 'pr',
      reason: 'PR head ref changed since recording',
      evidence: { expected: output.headRef, actual: view.headRefName },
    };
  }
  return { kind: 'verified-applied', phase: 'pr' };
}

async function verifyCommentSet(
  phase: 'codex' | 'bugbot',
  output: CodexPhaseOutput | BugbotPhaseOutput,
  prNumber: number,
  probes: VerifierProbes,
): Promise<PhaseVerificationResult> {
  if (output.commentIds.length === 0) {
    return { kind: 'verified-applied', phase };
  }
  const missing: string[] = [];
  for (const cid of output.commentIds) {
    const r = await probes.ghPrComment(prNumber, cid);
    if (!r.exists) missing.push(cid);
  }
  if (missing.length > 0) {
    return {
      kind: 'needs-human',
      phase,
      reason: `${missing.length}/${output.commentIds.length} ${phase} comment(s) no longer exist on the PR`,
      evidence: { missing, total: output.commentIds.length },
    };
  }
  return { kind: 'verified-applied', phase };
}

async function verifyMerge(
  output: MergePhaseOutput,
  prNumber: number | null,
  probes: VerifierProbes,
): Promise<PhaseVerificationResult> {
  // merge requires the PR number to query GH. If we don't have it from
  // the prior `pr` phase output, we cannot verify.
  if (prNumber === null) {
    return {
      kind: 'needs-human',
      phase: 'merge',
      reason: 'cannot verify merge without prior PR phase output',
      evidence: { mergeCommit: output.mergeCommit },
    };
  }
  const view = await probes.ghPrView(prNumber);
  if (!view) {
    return {
      kind: 'needs-human',
      phase: 'merge',
      reason: 'PR not found on GitHub at merge verification',
      evidence: { number: prNumber },
    };
  }
  if (view.mergedAt === null) {
    return {
      kind: 'needs-human',
      phase: 'merge',
      reason: 'PR is not merged on GitHub despite recorded merge output',
      evidence: { number: prNumber, recordedMergeCommit: output.mergeCommit },
    };
  }
  return { kind: 'verified-applied', phase: 'merge' };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface VerifyPhaseContext {
  /** Absolute repo root path. */
  repoRoot: string;
  /** worktree.path from the worktree phase output (if completed). */
  worktreePath?: string;
  /** PR number from the pr phase output (if completed). */
  prNumber?: number;
  probes: VerifierProbes;
}

/** Verify a single phase against its recorded output + external evidence.
 *  Returns one of three outcomes:
 *   - verified-applied: skip — evidence confirms the phase ran to completion
 *   - must-rerun:       re-run idempotently (validate report missing/stale)
 *   - needs-human:      cannot safely decide; operator must inspect */
export async function verifyPhaseEvidence(
  phase: SkillPhaseName,
  output: unknown,
  ctx: VerifyPhaseContext,
): Promise<PhaseVerificationResult> {
  switch (phase) {
    case 'spec':
      return verifyFileEvidence('spec', output as SpecPhaseOutput, ctx.repoRoot, ctx.probes);
    case 'plan':
      return verifyFileEvidence('plan', output as PlanPhaseOutput, ctx.repoRoot, ctx.probes);
    case 'worktree':
      return verifyWorktree(output as WorktreePhaseOutput, ctx.repoRoot, ctx.probes);
    case 'implement': {
      const wp = ctx.worktreePath;
      if (!wp) {
        return {
          kind: 'needs-human',
          phase: 'implement',
          reason: 'worktree path missing — cannot verify implement',
          evidence: {},
        };
      }
      return verifyImplementWithPath(output as ImplementPhaseOutput, wp, ctx.probes);
    }
    case 'migrate':
      return verifyMigrate(output as MigratePhaseOutput, ctx.probes);
    case 'validate':
      return verifyValidate(output as ValidatePhaseOutput, ctx.repoRoot, ctx.probes);
    case 'pr':
      return verifyPr(output as PrPhaseOutput, ctx.probes);
    case 'codex': {
      const num = ctx.prNumber;
      if (num === undefined) {
        return {
          kind: 'needs-human',
          phase: 'codex',
          reason: 'PR number missing — cannot verify codex comments',
          evidence: {},
        };
      }
      return verifyCommentSet('codex', output as CodexPhaseOutput, num, ctx.probes);
    }
    case 'bugbot': {
      const num = ctx.prNumber;
      if (num === undefined) {
        return {
          kind: 'needs-human',
          phase: 'bugbot',
          reason: 'PR number missing — cannot verify bugbot comments',
          evidence: {},
        };
      }
      return verifyCommentSet('bugbot', output as BugbotPhaseOutput, num, ctx.probes);
    }
    case 'merge':
      return verifyMerge(output as MergePhaseOutput, ctx.prNumber ?? null, ctx.probes);
    default: {
      const _exhaustive: never = phase;
      void _exhaustive;
      return {
        kind: 'needs-human',
        phase,
        reason: `unknown phase: ${String(phase)}`,
        evidence: {},
      };
    }
  }
}

// Suppress unused warning — verifyImplement is exported for symmetry but
// never directly called (its variant verifyImplementWithPath is the one
// in use). Kept for forward-compat if a future caller wants to do the
// path-derive itself.
void verifyImplement;
