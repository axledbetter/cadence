// src/core/schema-changes/detectors/typescript.ts
//
// TypeScript public-export detector. Lazy-imports `typescript` so cadence
// install stays light when TS detection isn't opted into.

import * as crypto from 'node:crypto';
import type { SchemaChangeEntry } from '../types.ts';

interface DetectInput {
  file: string;
  beforeText?: string;
  afterText?: string;
}

interface ExportEntry {
  name: string;
  hash: string;
}

function shortHash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractExports(ts: any, file: string, text: string): Map<string, ExportEntry> {
  const out = new Map<string, ExportEntry>();
  if (!text.trim()) return out;
  let sf;
  try {
    sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  } catch {
    return out;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ts.forEachChild(sf, (node: any) => {
    if (!node.modifiers || !node.modifiers.some((m: { kind: number }) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      return;
    }
    // Handle each export declaration kind.
    if (node.kind === ts.SyntaxKind.FunctionDeclaration
      || node.kind === ts.SyntaxKind.ClassDeclaration
      || node.kind === ts.SyntaxKind.InterfaceDeclaration
      || node.kind === ts.SyntaxKind.TypeAliasDeclaration
      || node.kind === ts.SyntaxKind.EnumDeclaration) {
      const name = node.name?.escapedText ?? node.name?.text;
      if (typeof name === 'string') {
        out.set(name, { name, hash: shortHash(node.getText(sf)) });
      }
      return;
    }
    if (node.kind === ts.SyntaxKind.VariableStatement) {
      const decls = node.declarationList?.declarations ?? [];
      for (const d of decls) {
        const name = d.name?.escapedText ?? d.name?.text;
        if (typeof name === 'string') {
          out.set(name, { name, hash: shortHash(d.getText(sf)) });
        }
      }
    }
  });
  return out;
}

export async function detectTypescriptChanges(input: DetectInput): Promise<SchemaChangeEntry[]> {
  const after = input.afterText ?? '';
  const before = input.beforeText ?? '';

  if (after.trim().length === 0 && before.trim().length === 0) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ts: any;
  try {
    ts = await import('typescript');
  } catch {
    return [{
      file: input.file,
      kind: 'unknown.unsupported_kind',
      additive: false,
      description: 'typescript package not installed; install optional dependency to enable TS detection',
    }];
  }
  // Some bundlers package as default.
  if (ts.default && ts.createSourceFile === undefined) ts = ts.default;

  const afterExports = extractExports(ts, input.file, after);
  const beforeExports = extractExports(ts, input.file, before);

  const entries: SchemaChangeEntry[] = [];
  let statementIndex = 0;

  for (const [name, after] of afterExports) {
    const before = beforeExports.get(name);
    if (!before) {
      entries.push({
        file: input.file,
        kind: 'typescript.add_export',
        objectName: name,
        statementIndex: statementIndex++,
        additive: true,
        description: `Add export ${name}`,
      });
    } else if (before.hash !== after.hash) {
      entries.push({
        file: input.file,
        kind: 'typescript.change_signature',
        objectName: name,
        statementIndex: statementIndex++,
        additive: false,
        description: `Change signature of export ${name}`,
      });
    }
  }
  for (const [name] of beforeExports) {
    if (!afterExports.has(name)) {
      entries.push({
        file: input.file,
        kind: 'typescript.remove_export',
        objectName: name,
        statementIndex: statementIndex++,
        additive: false,
        description: `Remove export ${name}`,
      });
    }
  }
  return entries;
}
