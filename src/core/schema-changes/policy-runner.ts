// src/core/schema-changes/policy-runner.ts
//
// Glue: read the implement-phase artifact, run enforcePolicy, return a
// structured verdict. Used by the validate phase to block on policy
// violations. Codex CRITICAL fix — wires `enforcePolicy()` into the
// pipeline (without this, the policy code is dead).

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  enforcePolicy,
  type PolicyIssue,
  type SchemaChangePolicy,
  type PairedWithProbe,
} from './validator.ts';
import { validateSchemaChanges } from './types.ts';

export interface PolicyRunnerOpts {
  /** Absolute path to the run directory (contains artifacts/implement.json). */
  runDir: string;
  /** Profile schemaChangePolicy. Defaults applied inside enforcePolicy. */
  policy?: SchemaChangePolicy;
  /** Optional probe for pairedWithMustExist. */
  probe?: PairedWithProbe;
}

export interface PolicyRunnerResult {
  ok: boolean;
  issues: PolicyIssue[];
  manifestPath: string | null;
}

export async function runSchemaPolicyCheck(opts: PolicyRunnerOpts): Promise<PolicyRunnerResult> {
  const artifactPath = path.join(opts.runDir, 'artifacts', 'implement.json');
  if (!fs.existsSync(artifactPath)) {
    // No implement phase ran yet — nothing to enforce.
    return { ok: true, issues: [], manifestPath: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  } catch {
    return { ok: true, issues: [], manifestPath: artifactPath };
  }
  const schemaChanges = (raw as { schemaChanges?: unknown }).schemaChanges;
  if (!schemaChanges) return { ok: true, issues: [], manifestPath: artifactPath };
  const v = validateSchemaChanges(schemaChanges);
  if (!v.ok) {
    // Treat shape failure as a block — the agent shipped an invalid
    // manifest.
    return {
      ok: false,
      manifestPath: artifactPath,
      issues: [{ severity: 'block', code: 'destructive_without_expand_contract', message: `schemaChanges shape invalid: ${v.error}`, entry: { file: '?', kind: 'unknown.unparseable', additive: false, description: v.error } }],
    };
  }
  const policyOpts: Parameters<typeof enforcePolicy>[0] = { manifest: v.value };
  if (opts.policy) policyOpts.policy = opts.policy;
  if (opts.probe) policyOpts.probe = opts.probe;
  const result = await enforcePolicy(policyOpts);
  return { ok: result.ok, issues: result.issues, manifestPath: artifactPath };
}
