// src/core/schema-changes/detectors/index.ts
//
// Dispatcher — pick the right detector for a file path and run it.

import type { SchemaChangeEntry } from '../types.ts';
import { detectSqlChanges } from './sql.ts';
import { detectGraphqlChanges } from './graphql.ts';
import { detectOpenapiChanges } from './openapi.ts';
import { detectTypescriptChanges } from './typescript.ts';
import { detectProtobufChanges } from './protobuf.ts';

export interface DiffFile {
  path: string;
  beforeText?: string;
  afterText?: string;
}

export type DetectorFn = (input: { file: string; beforeText?: string; afterText?: string }) => Promise<SchemaChangeEntry[]>;

const OPENAPI_RE = /(?:^|\/)(openapi|swagger)\.(ya?ml|json)$/i;

export function selectDetector(filePath: string): DetectorFn | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.sql')) return detectSqlChanges;
  if (lower.endsWith('.graphql') || lower.endsWith('.gql')) return detectGraphqlChanges;
  if (OPENAPI_RE.test(filePath) || lower.includes('/openapi/')) return detectOpenapiChanges;
  if (lower.endsWith('.proto')) return detectProtobufChanges;
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return detectTypescriptChanges;
  return null;
}

export async function detectChangesForFile(input: DiffFile): Promise<SchemaChangeEntry[]> {
  const detector = selectDetector(input.path);
  if (!detector) {
    // Unknown extension — caller asked for detection but we have no
    // detector. Emit a single unsupported_kind entry so the agent can
    // hand-author the manifest.
    return [{
      file: input.path,
      kind: 'unknown.unsupported_kind',
      additive: false,
      description: `No detector for file path "${input.path}"; agent must hand-author this manifest entry`,
    }];
  }
  return detector({
    file: input.path,
    beforeText: input.beforeText,
    afterText: input.afterText,
  });
}

export async function detectAllChanges(files: DiffFile[]): Promise<SchemaChangeEntry[]> {
  const out: SchemaChangeEntry[] = [];
  for (const f of files) {
    const entries = await detectChangesForFile(f);
    out.push(...entries);
  }
  return out;
}
