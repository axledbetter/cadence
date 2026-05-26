// src/cli/migrate-classify.ts
//
// `cadence migrate classify --file=<path>` — Phase 1 of issue #179.
//
// Reads a single .sql file and prints a classification envelope (JSON by
// default, or `--format=human` for an operator-friendly table). Exit code
// matrix per the spec:
//
//   0 — safe to apply (additive, bypassed, or ambiguous pinned to
//       additive/expand)
//   1 — file requires expand/contract treatment (destructive, or
//       ambiguous pinned to destructive/contract)
//   2 — file needs an explicit annotation (ambiguous with no pin)
//   3 — usage error (missing file, unreadable, etc.) — surfaced to
//       distinguish operator mistakes from policy decisions

import * as fs from 'node:fs';
import * as path from 'node:path';
import { classify, type ClassificationResult } from '../core/migrate/classify.ts';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

export interface MigrateClassifyOptions {
  filePath: string;
  format?: 'json' | 'human';
}

export async function runMigrateClassify(opts: MigrateClassifyOptions): Promise<number> {
  const absPath = path.resolve(process.cwd(), opts.filePath);
  let sql: string;
  try {
    sql = fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    console.error(`error: could not read ${opts.filePath}: ${(err as Error).message}`);
    return 3;
  }

  const result = classify(sql);
  const exitCode = exitCodeFor(result);

  if (opts.format === 'human') {
    renderHuman(result, opts.filePath, exitCode);
  } else {
    renderJson(result, opts.filePath, exitCode);
  }

  return exitCode;
}

function exitCodeFor(r: ClassificationResult): number {
  if (r.bypassed) return 0;
  if (r.classification === 'additive') return 0;
  if (r.classification === 'destructive') return 1;
  // ambiguous
  if (!r.pinned) return 2;
  switch (r.pinnedAs) {
    case 'additive':
    case 'expand':
      return 0;
    case 'destructive':
    case 'contract':
      return 1;
    default:
      return 2;
  }
}

function renderJson(r: ClassificationResult, file: string, exitCode: number): void {
  const envelope = {
    file,
    classification: r.classification,
    pinned: r.pinned,
    pinnedAs: r.pinnedAs,
    bypassed: r.bypassed,
    bypassReason: r.bypassReason,
    annotation: r.annotation,
    parseWarnings: r.parseWarnings,
    lexerComplete: r.lexerComplete,
    statements: r.statements,
    exitCode,
  };
  console.log(JSON.stringify(envelope, null, 2));
}

function renderHuman(r: ClassificationResult, file: string, exitCode: number): void {
  const verdict = exitCode === 0
    ? `${C.green}OK${C.reset}`
    : exitCode === 1
    ? `${C.red}BLOCKED${C.reset}`
    : `${C.yellow}NEEDS ANNOTATION${C.reset}`;
  console.log(`${C.bold}${file}${C.reset}  ${verdict}  (${r.classification}${r.pinned ? ` → pinned ${r.pinnedAs}` : ''}${r.bypassed ? ' → bypassed' : ''})`);

  if (r.bypassReason) {
    console.log(`  ${C.cyan}bypass:${C.reset} ${r.bypassReason}`);
  }
  if (r.annotation?.contractAfter) {
    console.log(`  ${C.cyan}contract_after:${C.reset} ${r.annotation.contractAfter}`);
  }
  if (r.annotation?.contractReason) {
    console.log(`  ${C.cyan}contract_reason:${C.reset} ${r.annotation.contractReason}`);
  }
  if (r.parseWarnings.length > 0) {
    console.log(`  ${C.yellow}warnings:${C.reset}`);
    for (const w of r.parseWarnings) console.log(`    - ${w}`);
  }
  console.log(`  ${C.dim}statements:${C.reset}`);
  for (const s of r.statements) {
    const color = s.classification === 'destructive'
      ? C.red
      : s.classification === 'ambiguous'
      ? C.yellow
      : C.green;
    console.log(`    L${s.startLine}  ${color}${s.classification}${C.reset} (${s.rule}) — ${s.reason}`);
    console.log(`           ${C.dim}${s.sql.length > 80 ? s.sql.slice(0, 80) + '…' : s.sql}${C.reset}`);
  }
}
