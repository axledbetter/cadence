import * as fs from 'node:fs/promises';
import * as yaml from 'js-yaml';
import Ajv from 'ajv';
import { GuardrailError } from '../errors.ts';
import type { GuardrailConfig } from './types.ts';
import { GUARDRAIL_CONFIG_SCHEMA } from './schema.ts';

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(GUARDRAIL_CONFIG_SCHEMA);

/** v8.1.1 — known + historical `budgets.*` keys (issue #210). The schema
 *  is `additionalProperties: false`, so any other key fails validation
 *  outright; this set is used for the PRE-validation `console.warn` that
 *  pinpoints the unknown key for the user (and `cadence doctor`) BEFORE
 *  the generic Ajv error fires. Historical keys (none yet) stay listed
 *  here as deprecated members so they don't trip the warning. */
export const KNOWN_BUDGET_KEYS: ReadonlySet<string> = new Set([
  'perRunUSD',
  'perPhaseUSD',
  'perSubagentUSD',
  'conservativePhaseReserveUSD',
]);

export interface UnknownBudgetKey {
  key: string;
  /** Closest known key by case-insensitive equality, if any. Helps users
   *  spot case typos like `perSubAgentUsd` → `perSubagentUSD`. */
  didYouMean?: string;
}

/** Walk `config.budgets` (if present and object-shaped) and return any
 *  keys not in {@link KNOWN_BUDGET_KEYS}. Pure — no IO, no side effects.
 *  Used by both the loader (which emits the warning) and tests. */
export function findUnknownBudgetKeys(parsed: unknown): UnknownBudgetKey[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const budgets = (parsed as Record<string, unknown>).budgets;
  if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets)) return [];

  const out: UnknownBudgetKey[] = [];
  const knownLower = new Map<string, string>();
  for (const k of KNOWN_BUDGET_KEYS) knownLower.set(k.toLowerCase(), k);

  for (const key of Object.keys(budgets as Record<string, unknown>)) {
    if (KNOWN_BUDGET_KEYS.has(key)) continue;
    const didYouMean = knownLower.get(key.toLowerCase());
    out.push(didYouMean ? { key, didYouMean } : { key });
  }
  return out;
}

/** Format an unknown-budget-key list as `console.warn` lines. Exposed so
 *  `cadence doctor` can render the same messages without re-running the
 *  loader. */
export function formatBudgetWarnings(unknown: UnknownBudgetKey[]): string[] {
  return unknown.map(u => {
    const suggestion = u.didYouMean
      ? ` — did you mean "${u.didYouMean}"?`
      : ` — recognized keys: ${[...KNOWN_BUDGET_KEYS].join(', ')}`;
    return `[budgets] unknown key "${u.key}"${suggestion}`;
  });
}

export async function loadConfig(path: string): Promise<GuardrailConfig> {
  let content: string;
  try {
    content = await fs.readFile(path, 'utf8');
  } catch (err) {
    throw new GuardrailError(`Config file not found: ${path}`, {
      code: 'user_input',
      details: { path, cause: err instanceof Error ? err.message : String(err) },
    });
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    throw new GuardrailError(`Invalid YAML in ${path}`, {
      code: 'invalid_config',
      details: { path, cause: err instanceof Error ? err.message : String(err) },
    });
  }

  // v8.1.1 issue #210 — emit a `console.warn` BEFORE schema validation
  // so the user sees the offending budgets.* key name even if the schema
  // error (additionalProperties: false) buries it under generic text.
  // Doctor consumes the same list via {@link findUnknownBudgetKeys}.
  const unknownBudgetKeys = findUnknownBudgetKeys(parsed);
  for (const line of formatBudgetWarnings(unknownBudgetKeys)) {
    console.warn(line);
  }

  if (!validate(parsed)) {
    const errors = (validate.errors ?? []).map(e => {
      const loc = e.instancePath ? e.instancePath.replace(/^\//, '').replace(/\//g, '.') : '<root>';
      // enum errors: list allowed values
      if (e.keyword === 'enum' && Array.isArray(e.params?.allowedValues)) {
        return `${loc}: must be one of ${(e.params.allowedValues as unknown[]).map(v => JSON.stringify(v)).join(', ')}`;
      }
      // additionalProperties: name the unexpected key
      if (e.keyword === 'additionalProperties' && e.params?.additionalProperty) {
        return `${loc}: unexpected key "${e.params.additionalProperty as string}"`;
      }
      return `${loc}: ${e.message ?? 'invalid'}`;
    });
    const summary = errors.slice(0, 5).join('\n  ');
    throw new GuardrailError(
      `guardrail.config.yaml is invalid:\n  ${summary}${errors.length > 5 ? `\n  …and ${errors.length - 5} more` : ''}`,
      { code: 'invalid_config', details: { path, errors } },
    );
  }

  return parsed as GuardrailConfig;
}
