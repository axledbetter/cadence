// src/core/schema-changes/detectors/openapi.ts
//
// OpenAPI (JSON / YAML) detector. js-yaml is already a runtime dep.

import yaml from 'js-yaml';
import type { SchemaChangeEntry } from '../types.ts';

interface DetectInput {
  file: string;
  beforeText?: string;
  afterText?: string;
}

function parseSpec(text: string, file: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  const isJson = file.endsWith('.json');
  try {
    if (isJson) return JSON.parse(text);
    const loaded = yaml.load(text);
    return (loaded && typeof loaded === 'object') ? (loaded as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function getPaths(spec: Record<string, unknown> | null): Record<string, Record<string, unknown>> {
  if (!spec) return {};
  const p = spec.paths;
  if (!p || typeof p !== 'object') return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (v && typeof v === 'object') out[k] = v as Record<string, unknown>;
  }
  return out;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function getOperations(pathItem: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const m of HTTP_METHODS) {
    const op = pathItem[m];
    if (op && typeof op === 'object') out.set(m, op as Record<string, unknown>);
  }
  return out;
}

function hashOp(op: Record<string, unknown>, key: 'requestBody' | 'responses'): string {
  return JSON.stringify(op[key] ?? null);
}

export async function detectOpenapiChanges(input: DetectInput): Promise<SchemaChangeEntry[]> {
  const after = input.afterText ?? '';
  const before = input.beforeText ?? '';

  if (after.trim().length === 0 && before.trim().length === 0) return [];

  const afterSpec = parseSpec(after, input.file);
  const beforeSpec = parseSpec(before, input.file);

  // Treat one of them being null but the other non-empty as "no manifest entry needed if both empty" — we already returned above.
  if (afterSpec === null && after.trim().length > 0) {
    return [{
      file: input.file,
      kind: 'unknown.unparseable',
      additive: false,
      description: 'OpenAPI parse failed; agent must hand-author this manifest entry',
    }];
  }

  const afterPaths = getPaths(afterSpec);
  const beforePaths = getPaths(beforeSpec);
  const entries: SchemaChangeEntry[] = [];
  let statementIndex = 0;

  // Added endpoints.
  for (const [path, item] of Object.entries(afterPaths)) {
    const beforeItem = beforePaths[path];
    const afterOps = getOperations(item);
    const beforeOps = beforeItem ? getOperations(beforeItem) : new Map<string, Record<string, unknown>>();
    for (const [method, op] of afterOps) {
      const beforeOp = beforeOps.get(method);
      if (!beforeOp) {
        entries.push({
          file: input.file,
          kind: 'openapi.add_endpoint',
          objectName: path,
          subObjectName: method,
          statementIndex: statementIndex++,
          additive: true,
          description: `Add endpoint ${method.toUpperCase()} ${path}`,
        });
        continue;
      }
      if (hashOp(op, 'responses') !== hashOp(beforeOp, 'responses')) {
        entries.push({
          file: input.file,
          kind: 'openapi.change_response',
          objectName: path,
          subObjectName: method,
          statementIndex: statementIndex++,
          additive: false,
          description: `Change response for ${method.toUpperCase()} ${path}`,
        });
      }
      if (hashOp(op, 'requestBody') !== hashOp(beforeOp, 'requestBody')) {
        entries.push({
          file: input.file,
          kind: 'openapi.change_request',
          objectName: path,
          subObjectName: method,
          statementIndex: statementIndex++,
          additive: false,
          description: `Change request body for ${method.toUpperCase()} ${path}`,
        });
      }
    }
    for (const [method] of beforeOps) {
      if (!afterOps.has(method)) {
        entries.push({
          file: input.file,
          kind: 'openapi.remove_endpoint',
          objectName: path,
          subObjectName: method,
          statementIndex: statementIndex++,
          additive: false,
          description: `Remove endpoint ${method.toUpperCase()} ${path}`,
        });
      }
    }
  }
  // Removed paths entirely.
  for (const [path, item] of Object.entries(beforePaths)) {
    if (afterPaths[path]) continue;
    for (const [method] of getOperations(item)) {
      entries.push({
        file: input.file,
        kind: 'openapi.remove_endpoint',
        objectName: path,
        subObjectName: method,
        statementIndex: statementIndex++,
        additive: false,
        description: `Remove endpoint ${method.toUpperCase()} ${path}`,
      });
    }
  }
  return entries;
}
