// src/core/autopilot/run-state-schema.ts
//
// Typed phase-output schema for the 10-phase autopilot skill flow.
// Pure module: no IO, no filesystem, no network.
//
// Spec: docs/superpowers/specs/2026-05-27-autopilot-run-state-integration-design.md
// Plan: docs/superpowers/plans/2026-05-27-autopilot-run-state-integration.md

import * as crypto from 'node:crypto';
import {
  type SchemaChangeEntry,
  validateSchemaChanges,
} from '../schema-changes/types.ts';

// ---------------------------------------------------------------------------
// Skill phase model
// ---------------------------------------------------------------------------

export type SkillPhaseName =
  | 'spec'
  | 'plan'
  | 'worktree'
  | 'implement'
  | 'migrate'
  | 'validate'
  | 'pr'
  | 'codex'
  | 'bugbot'
  | 'merge';

export const SKILL_PHASES: readonly SkillPhaseName[] = [
  'spec',
  'plan',
  'worktree',
  'implement',
  'migrate',
  'validate',
  'pr',
  'codex',
  'bugbot',
  'merge',
] as const;

export interface PhaseContract {
  idempotent: boolean;
  hasSideEffects: boolean;
  preEffectRefKinds: readonly string[];
  postEffectRefKinds: readonly string[];
}

export const PHASE_CONTRACTS: Readonly<Record<SkillPhaseName, PhaseContract>> = {
  spec:      { idempotent: true,  hasSideEffects: false, preEffectRefKinds: [], postEffectRefKinds: [] },
  plan:      { idempotent: true,  hasSideEffects: false, preEffectRefKinds: [], postEffectRefKinds: [] },
  worktree:  { idempotent: false, hasSideEffects: true,  preEffectRefKinds: [], postEffectRefKinds: [] },
  implement: { idempotent: false, hasSideEffects: true,  preEffectRefKinds: [], postEffectRefKinds: [] },
  migrate:   { idempotent: false, hasSideEffects: true,  preEffectRefKinds: ['migration-batch'], postEffectRefKinds: ['migration-version'] },
  validate:  { idempotent: true,  hasSideEffects: false, preEffectRefKinds: [], postEffectRefKinds: [] },
  pr:        { idempotent: false, hasSideEffects: true,  preEffectRefKinds: ['github-pr'], postEffectRefKinds: [] },
  codex:     { idempotent: false, hasSideEffects: true,  preEffectRefKinds: [], postEffectRefKinds: ['github-comment'] },
  bugbot:    { idempotent: false, hasSideEffects: true,  preEffectRefKinds: [], postEffectRefKinds: ['github-comment'] },
  merge:     { idempotent: false, hasSideEffects: true,  preEffectRefKinds: ['github-pr'], postEffectRefKinds: [] },
};

// ---------------------------------------------------------------------------
// Per-phase typed output shapes
// ---------------------------------------------------------------------------

export interface SpecPhaseOutput {
  path: string;
  sha: string;
  size: number;
}

export interface PlanPhaseOutput {
  path: string;
  sha: string;
  size: number;
}

export interface WorktreePhaseOutput {
  path: string;
  branch: string;
  createdAt: string;
}

export interface ImplementPhaseOutput {
  baseSha: string;
  headSha: string;
  commits: string[];
  cleanAtComplete: boolean;
  /**
   * Typed manifest of every semantic schema change introduced by this
   * implement phase. ONE ENTRY PER SEMANTIC CHANGE — a SQL migration with
   * five statements emits five entries.
   *
   * Optional at the schema level — only required when
   * `profile.schemaPaths.length > 0`. The lifecycle/validate paths gate
   * enforcement on that profile setting.
   *
   * Spec: docs/superpowers/specs/2026-05-27-schema-change-manifests-design.md
   */
  schemaChanges?: SchemaChangeEntry[];
}

export interface MigrateAppliedRecord {
  id: string;
  checksum: string;
  appliedAt: string;
}

export interface MigratePhaseOutput {
  appliedMigrations: MigrateAppliedRecord[];
}

export interface ValidatePhaseOutput {
  reportPath: string;
  reportSha: string;
  verdict: 'pass' | 'fail';
}

export interface PrPhaseOutput {
  number: number;
  url: string;
  headRef: string;
  headShaAtCreate: string;
}

export interface CodexPhaseOutput {
  iterations: number;
  commentIds: string[];
}

export interface BugbotPhaseOutput {
  rounds: number;
  commentIds: string[];
  fixed: string[];
  dismissed: string[];
}

export interface MergePhaseOutput {
  mergedAt: string;
  mergeCommit: string;
}

export interface AutopilotPhaseOutputs {
  spec?: SpecPhaseOutput;
  plan?: PlanPhaseOutput;
  worktree?: WorktreePhaseOutput;
  implement?: ImplementPhaseOutput;
  migrate?: MigratePhaseOutput;
  validate?: ValidatePhaseOutput;
  pr?: PrPhaseOutput;
  codex?: CodexPhaseOutput;
  bugbot?: BugbotPhaseOutput;
  merge?: MergePhaseOutput;
}

// ---------------------------------------------------------------------------
// Top-level autopilot run config — stored inside v6 RunState.config
// ---------------------------------------------------------------------------

export interface AutopilotRunConfig {
  cadenceVersion: string;
  argv: readonly string[];
  createdByCommand: 'autopilot';
  featureFlags: Record<string, boolean>;
  specPath: string;
  repoRoot: string;
  worktreePath?: string;
  branch?: string;
  baseSha?: string;
  profile: string;
  profileSnapshot: Record<string, unknown>;
  phaseOutputs: AutopilotPhaseOutputs;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export type ValidateResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const SHA_FULL_HEX = /^[0-9a-f]{40}$/i;
const SHA256_PREFIXED = /^sha256:[0-9a-f]{64}$/i;

function isFullCommitSha(s: unknown): s is string {
  return typeof s === 'string' && SHA_FULL_HEX.test(s);
}

function isSha256Prefixed(s: unknown): s is string {
  return typeof s === 'string' && SHA256_PREFIXED.test(s);
}

function isIsoTimestamp(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  const t = Date.parse(s);
  return Number.isFinite(t);
}

function isHttpsUrl(s: unknown): boolean {
  if (typeof s !== 'string' || s.length === 0) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function isNonEmptyString(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0;
}

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

function failR<T>(msg: string): ValidateResult<T> {
  return { ok: false, error: msg };
}

function validateFileEvidence(
  output: unknown,
  phase: 'spec' | 'plan',
): ValidateResult<SpecPhaseOutput | PlanPhaseOutput> {
  if (output === null || typeof output !== 'object') {
    return failR(`${phase}: output must be an object`);
  }
  const o = output as Record<string, unknown>;
  if (!isNonEmptyString(o.path)) return failR(`${phase}.path must be a non-empty string`);
  if (!isSha256Prefixed(o.sha)) return failR(`${phase}.sha must be "sha256:<64-hex>"`);
  if (!isPositiveInt(o.size)) return failR(`${phase}.size must be a non-negative integer`);
  return { ok: true, value: { path: o.path, sha: o.sha as string, size: o.size as number } };
}

function validateWorktree(output: unknown): ValidateResult<WorktreePhaseOutput> {
  if (output === null || typeof output !== 'object') return failR('worktree: output must be an object');
  const o = output as Record<string, unknown>;
  if (!isNonEmptyString(o.path)) return failR('worktree.path must be a non-empty string');
  if (!isNonEmptyString(o.branch)) return failR('worktree.branch must be a non-empty string');
  if (!isIsoTimestamp(o.createdAt)) return failR('worktree.createdAt must be ISO-8601');
  return { ok: true, value: { path: o.path, branch: o.branch as string, createdAt: o.createdAt as string } };
}

function validateImplement(output: unknown): ValidateResult<ImplementPhaseOutput> {
  if (output === null || typeof output !== 'object') return failR('implement: output must be an object');
  const o = output as Record<string, unknown>;
  if (!isFullCommitSha(o.baseSha)) return failR('implement.baseSha must be a 40-hex commit SHA');
  if (!isFullCommitSha(o.headSha)) return failR('implement.headSha must be a 40-hex commit SHA');
  if (!Array.isArray(o.commits) || o.commits.length === 0) {
    return failR('implement.commits must be a non-empty array');
  }
  for (let i = 0; i < o.commits.length; i++) {
    if (!isFullCommitSha(o.commits[i])) {
      return failR(`implement.commits[${i}] must be a 40-hex commit SHA`);
    }
  }
  if (typeof o.cleanAtComplete !== 'boolean') {
    return failR('implement.cleanAtComplete must be boolean');
  }
  // schemaChanges is optional — when present, validate shape.
  let schemaChanges: SchemaChangeEntry[] | undefined;
  if (o.schemaChanges !== undefined) {
    const r = validateSchemaChanges(o.schemaChanges);
    if (!r.ok) return failR(`implement.${r.error}`);
    schemaChanges = r.value;
  }
  return {
    ok: true,
    value: {
      baseSha: o.baseSha as string,
      headSha: o.headSha as string,
      commits: o.commits as string[],
      cleanAtComplete: o.cleanAtComplete,
      ...(schemaChanges !== undefined ? { schemaChanges } : {}),
    },
  };
}

function validateMigrate(output: unknown): ValidateResult<MigratePhaseOutput> {
  if (output === null || typeof output !== 'object') return failR('migrate: output must be an object');
  const o = output as Record<string, unknown>;
  if (!Array.isArray(o.appliedMigrations)) {
    return failR('migrate.appliedMigrations must be an array');
  }
  const recs: MigrateAppliedRecord[] = [];
  for (let i = 0; i < o.appliedMigrations.length; i++) {
    const r = o.appliedMigrations[i];
    if (r === null || typeof r !== 'object') {
      return failR(`migrate.appliedMigrations[${i}] must be an object`);
    }
    const rr = r as Record<string, unknown>;
    if (!isNonEmptyString(rr.id)) return failR(`migrate.appliedMigrations[${i}].id must be non-empty`);
    if (!isSha256Prefixed(rr.checksum)) {
      return failR(`migrate.appliedMigrations[${i}].checksum must be "sha256:<64-hex>"`);
    }
    if (!isIsoTimestamp(rr.appliedAt)) {
      return failR(`migrate.appliedMigrations[${i}].appliedAt must be ISO-8601`);
    }
    recs.push({ id: rr.id, checksum: rr.checksum as string, appliedAt: rr.appliedAt as string });
  }
  return { ok: true, value: { appliedMigrations: recs } };
}

function validateValidate(output: unknown): ValidateResult<ValidatePhaseOutput> {
  if (output === null || typeof output !== 'object') return failR('validate: output must be an object');
  const o = output as Record<string, unknown>;
  if (!isNonEmptyString(o.reportPath)) return failR('validate.reportPath must be non-empty');
  if (!isSha256Prefixed(o.reportSha)) return failR('validate.reportSha must be "sha256:<64-hex>"');
  if (o.verdict !== 'pass' && o.verdict !== 'fail') {
    return failR('validate.verdict must be "pass" or "fail"');
  }
  return {
    ok: true,
    value: { reportPath: o.reportPath, reportSha: o.reportSha as string, verdict: o.verdict },
  };
}

function validatePr(output: unknown): ValidateResult<PrPhaseOutput> {
  if (output === null || typeof output !== 'object') return failR('pr: output must be an object');
  const o = output as Record<string, unknown>;
  if (!isPositiveInt(o.number) || (o.number as number) <= 0) {
    return failR('pr.number must be a positive integer');
  }
  if (!isHttpsUrl(o.url)) return failR('pr.url must be a valid http(s) URL');
  if (!isNonEmptyString(o.headRef)) return failR('pr.headRef must be non-empty');
  if (!isFullCommitSha(o.headShaAtCreate)) {
    return failR('pr.headShaAtCreate must be a 40-hex commit SHA');
  }
  return {
    ok: true,
    value: {
      number: o.number as number,
      url: o.url as string,
      headRef: o.headRef as string,
      headShaAtCreate: o.headShaAtCreate as string,
    },
  };
}

function validateCodex(output: unknown): ValidateResult<CodexPhaseOutput> {
  if (output === null || typeof output !== 'object') return failR('codex: output must be an object');
  const o = output as Record<string, unknown>;
  if (!isPositiveInt(o.iterations) || (o.iterations as number) === 0) {
    return failR('codex.iterations must be a positive integer');
  }
  if (!Array.isArray(o.commentIds) || o.commentIds.length === 0) {
    return failR('codex.commentIds must be a non-empty array');
  }
  for (let i = 0; i < o.commentIds.length; i++) {
    if (!isNonEmptyString(o.commentIds[i])) {
      return failR(`codex.commentIds[${i}] must be a non-empty string`);
    }
  }
  return {
    ok: true,
    value: { iterations: o.iterations as number, commentIds: o.commentIds as string[] },
  };
}

function validateBugbot(output: unknown): ValidateResult<BugbotPhaseOutput> {
  if (output === null || typeof output !== 'object') return failR('bugbot: output must be an object');
  const o = output as Record<string, unknown>;
  if (!isPositiveInt(o.rounds) || (o.rounds as number) === 0) {
    return failR('bugbot.rounds must be a positive integer');
  }
  if (!Array.isArray(o.commentIds)) return failR('bugbot.commentIds must be an array');
  if (!Array.isArray(o.fixed)) return failR('bugbot.fixed must be an array');
  if (!Array.isArray(o.dismissed)) return failR('bugbot.dismissed must be an array');
  for (const arr of [o.commentIds, o.fixed, o.dismissed] as unknown[][]) {
    for (const c of arr) {
      if (!isNonEmptyString(c)) {
        return failR('bugbot.commentIds/fixed/dismissed entries must be non-empty strings');
      }
    }
  }
  return {
    ok: true,
    value: {
      rounds: o.rounds as number,
      commentIds: o.commentIds as string[],
      fixed: o.fixed as string[],
      dismissed: o.dismissed as string[],
    },
  };
}

function validateMerge(output: unknown): ValidateResult<MergePhaseOutput> {
  if (output === null || typeof output !== 'object') return failR('merge: output must be an object');
  const o = output as Record<string, unknown>;
  if (!isIsoTimestamp(o.mergedAt)) return failR('merge.mergedAt must be ISO-8601');
  if (!isFullCommitSha(o.mergeCommit)) return failR('merge.mergeCommit must be a 40-hex commit SHA');
  return {
    ok: true,
    value: { mergedAt: o.mergedAt as string, mergeCommit: o.mergeCommit as string },
  };
}

export function validatePhaseOutput<P extends SkillPhaseName>(
  phase: P,
  output: unknown,
): ValidateResult<NonNullable<AutopilotPhaseOutputs[P]>> {
  switch (phase) {
    case 'spec':      return validateFileEvidence(output, 'spec') as ValidateResult<NonNullable<AutopilotPhaseOutputs[P]>>;
    case 'plan':      return validateFileEvidence(output, 'plan') as ValidateResult<NonNullable<AutopilotPhaseOutputs[P]>>;
    case 'worktree':  return validateWorktree(output) as ValidateResult<NonNullable<AutopilotPhaseOutputs[P]>>;
    case 'implement': return validateImplement(output) as ValidateResult<NonNullable<AutopilotPhaseOutputs[P]>>;
    case 'migrate':   return validateMigrate(output) as ValidateResult<NonNullable<AutopilotPhaseOutputs[P]>>;
    case 'validate':  return validateValidate(output) as ValidateResult<NonNullable<AutopilotPhaseOutputs[P]>>;
    case 'pr':        return validatePr(output) as ValidateResult<NonNullable<AutopilotPhaseOutputs[P]>>;
    case 'codex':     return validateCodex(output) as ValidateResult<NonNullable<AutopilotPhaseOutputs[P]>>;
    case 'bugbot':    return validateBugbot(output) as ValidateResult<NonNullable<AutopilotPhaseOutputs[P]>>;
    case 'merge':     return validateMerge(output) as ValidateResult<NonNullable<AutopilotPhaseOutputs[P]>>;
    default: {
      const _exhaustive: never = phase;
      void _exhaustive;
      return failR(`unknown phase: ${String(phase)}`);
    }
  }
}

export function validateAutopilotRunConfig(cfg: unknown): ValidateResult<AutopilotRunConfig> {
  if (cfg === null || typeof cfg !== 'object') return failR('config must be an object');
  const c = cfg as Record<string, unknown>;
  if (!isNonEmptyString(c.cadenceVersion)) return failR('config.cadenceVersion must be non-empty');
  if (!Array.isArray(c.argv)) return failR('config.argv must be an array');
  if (c.createdByCommand !== 'autopilot') return failR('config.createdByCommand must be "autopilot"');
  if (c.featureFlags === null || typeof c.featureFlags !== 'object') {
    return failR('config.featureFlags must be an object');
  }
  if (!isNonEmptyString(c.specPath)) return failR('config.specPath must be non-empty');
  if (!isNonEmptyString(c.repoRoot)) return failR('config.repoRoot must be non-empty');
  if (!isNonEmptyString(c.profile)) return failR('config.profile must be non-empty');
  if (c.profileSnapshot === null || typeof c.profileSnapshot !== 'object') {
    return failR('config.profileSnapshot must be an object');
  }
  if (c.phaseOutputs === null || typeof c.phaseOutputs !== 'object') {
    return failR('config.phaseOutputs must be an object');
  }
  return { ok: true, value: cfg as AutopilotRunConfig };
}

// ---------------------------------------------------------------------------
// Version compatibility — codex CRITICAL: major mismatch must refuse resume
// ---------------------------------------------------------------------------

export function parseCadenceVersion(v: string): { major: number; minor: number; patch: number } {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v);
  if (!m) throw new Error(`invalid cadence version: "${v}"`);
  return {
    major: Number(m[1]),
    minor: m[2] ? Number(m[2]) : 0,
    patch: m[3] ? Number(m[3]) : 0,
  };
}

export function isMajorCompatible(stateVersion: string, binaryVersion: string): boolean {
  try {
    return parseCadenceVersion(stateVersion).major === parseCadenceVersion(binaryVersion).major;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Canonical SHA helper
// ---------------------------------------------------------------------------

export function sha256OfBuffer(buf: Buffer | string): string {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}
