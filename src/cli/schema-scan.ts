// src/cli/schema-scan.ts
//
// `cadence schema scan` — produces a skeleton manifest from the current
// diff (worktree vs HEAD). Agents run this then hand-edit the `description`,
// `rollback`, `expandContract` fields.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { resolveProfile } from '../core/profile/resolver.ts';
import { makeGitDiffProvider, filterByGlobs } from '../core/schema-changes/diff-provider.ts';
import { detectAllChanges } from '../core/schema-changes/detectors/index.ts';

export interface SchemaScanOptions {
  cwd?: string;
  baseRef?: string;
  format?: 'json' | 'yaml';
  outputPath?: string;
  /** Override schemaPaths from the profile — useful when caller has no profile yet. */
  schemaPaths?: string[];
}

export interface SchemaScanResult {
  exit: number;
  stdout: string;
  stderr: string;
}

export async function runSchemaScan(options: SchemaScanOptions = {}): Promise<SchemaScanResult> {
  const cwd = options.cwd ?? process.cwd();
  const baseRef = options.baseRef ?? 'HEAD';
  const format = options.format ?? 'yaml';

  let schemaPaths = options.schemaPaths;
  if (!schemaPaths) {
    try {
      const resolved = await resolveProfile({ cwd });
      schemaPaths = resolved.config.schemaPaths ?? [];
    } catch {
      schemaPaths = [];
    }
  }
  if (!schemaPaths || schemaPaths.length === 0) {
    return {
      exit: 1,
      stdout: '',
      stderr: 'schema scan: profile.schemaPaths is empty and no --paths override given. Set schemaPaths in your profile or pass --paths "data/deltas/*.sql,**/*.proto".\n',
    };
  }

  const provider = makeGitDiffProvider(cwd);
  const all = await provider.collectChangedFiles({ baseRef, includeUntracked: true });
  const matched = filterByGlobs(all, schemaPaths);
  if (matched.length === 0) {
    const empty = format === 'json' ? '[]\n' : '[]\n';
    if (options.outputPath) {
      fs.writeFileSync(path.resolve(cwd, options.outputPath), empty, 'utf8');
    }
    return { exit: 0, stdout: empty, stderr: '' };
  }
  const entries = await detectAllChanges(matched.map((m) => ({ path: m.path, beforeText: m.beforeText, afterText: m.afterText })));
  const rendered = format === 'json' ? JSON.stringify(entries, null, 2) + '\n' : yaml.dump(entries, { lineWidth: 100 });
  if (options.outputPath) {
    fs.writeFileSync(path.resolve(cwd, options.outputPath), rendered, 'utf8');
  }
  return { exit: 0, stdout: rendered, stderr: '' };
}
