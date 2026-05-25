import * as path from 'node:path';
import { GuardrailError } from '../core/errors.ts';
import { checkApiVersionCompatibility, type AdapterBase } from './base.ts';
import { resolveSiblingModule } from '../cli/_pkg-root.ts';

export type IntegrationPoint = 'review-engine' | 'vcs-host' | 'migration-runner' | 'review-bot-parser';

export interface LoadAdapterOptions {
  point: IntegrationPoint;
  ref: string;
  options?: Record<string, unknown>;
  /** Allow loading adapters from arbitrary local paths. Off by default for security. */
  unsafeAllowLocalAdapters?: boolean;
}

const BUILTIN_PATHS: Record<IntegrationPoint, Record<string, string>> = {
  'review-engine': {
    codex: './review-engine/codex.ts',
    claude: './review-engine/claude.ts',
    gemini: './review-engine/gemini.ts',
    'openai-compatible': './review-engine/openai-compatible.ts',
    auto: './review-engine/auto.ts',
    bedrock: './review-engine/bedrock.ts',
    azure: './review-engine/azure.ts',
    cohere: './review-engine/cohere.ts',
    mistral: './review-engine/mistral.ts',
  },
  'vcs-host': { github: './vcs-host/github.ts' },
  'migration-runner': { supabase: './migration-runner/supabase.ts' },
  'review-bot-parser': { cursor: './review-bot-parser/cursor.ts' },
};

const REQUIRED_BY_POINT: Record<IntegrationPoint, string[]> = {
  'review-engine': ['review', 'estimateTokens'],
  'vcs-host': ['getPrDiff', 'getPrMetadata', 'postComment', 'getReviewComments', 'replyToComment', 'createPr', 'push'],
  'migration-runner': ['discover', 'dryRun', 'apply', 'ledger', 'alreadyApplied'],
  'review-bot-parser': ['detect', 'fetchFindings', 'detectDismissal'],
};

function isPathRef(ref: string): boolean {
  return ref.startsWith('./') || ref.startsWith('/') || ref.startsWith('../') || ref.endsWith('.ts') || ref.endsWith('.js');
}

export async function loadAdapter<T extends AdapterBase>(options: LoadAdapterOptions): Promise<T> {
  const { point, ref } = options;
  let modulePath: string;

  if (isPathRef(ref)) {
    if (!options.unsafeAllowLocalAdapters) {
      throw new GuardrailError(
        `Path-based adapter refs require unsafeAllowLocalAdapters:true — set this only for trusted local adapters`,
        { code: 'invalid_config', details: { point, ref } }
      );
    }
    modulePath = path.resolve(ref);
  } else {
    const builtin = BUILTIN_PATHS[point]?.[ref];
    if (!builtin) {
      throw new GuardrailError(`Unknown built-in ${point} adapter: "${ref}"`, {
        code: 'invalid_config',
        details: { point, ref, available: Object.keys(BUILTIN_PATHS[point] ?? {}) },
      });
    }
    modulePath = resolveSiblingModule(builtin, import.meta.url);
  }

  let mod: { default?: T } | T;
  try {
    mod = (await import(modulePath)) as { default?: T } | T;
  } catch (err) {
    throw new GuardrailError(`Failed to import adapter from ${modulePath}`, {
      code: 'invalid_config',
      details: { point, ref, modulePath, cause: err instanceof Error ? err.message : String(err) },
    });
  }

  const adapter = ('default' in mod ? mod.default : mod) as T;
  if (!adapter || typeof adapter !== 'object') {
    throw new GuardrailError(`Adapter module did not export a valid adapter object`, {
      code: 'invalid_config',
      details: { point, ref, modulePath },
    });
  }

  validateShape(adapter, point, modulePath);

  if (!checkApiVersionCompatibility(adapter.apiVersion)) {
    throw new GuardrailError(`Adapter apiVersion ${adapter.apiVersion} incompatible with core`, {
      code: 'invalid_config',
      details: { point, ref, adapterApiVersion: adapter.apiVersion },
    });
  }

  return adapter;
}

function validateShape(adapter: AdapterBase, point: IntegrationPoint, modulePath: string): void {
  const missing: string[] = [];
  const required = ['getCapabilities', ...REQUIRED_BY_POINT[point]];
  for (const method of required) {
    if (typeof (adapter as unknown as Record<string, unknown>)[method] !== 'function') missing.push(method);
  }
  if (typeof adapter.name !== 'string' || typeof adapter.apiVersion !== 'string') {
    missing.push('name/apiVersion');
  }
  if (missing.length > 0) {
    throw new GuardrailError(
      `Adapter at ${modulePath} missing required methods: ${missing.join(', ')}`,
      { code: 'invalid_config', details: { point, modulePath, missing } }
    );
  }
}
