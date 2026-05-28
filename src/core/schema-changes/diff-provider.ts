// src/core/schema-changes/diff-provider.ts
//
// Shared diff abstraction used by the lifecycle path (run-lifecycle) and
// the `cadence schema scan` CLI. The lifecycle path injects this so
// tests can stub the diff source.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DiffEntry {
  path: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  beforeText?: string;
  afterText?: string;
}

export interface DiffProvider {
  collectChangedFiles(opts: { baseRef: string; includeUntracked?: boolean }): Promise<DiffEntry[]>;
}

function execGit(repoRoot: string, args: string[]): { stdout: string; ok: boolean } {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return { stdout: r.stdout ?? '', ok: r.status === 0 };
}

export function makeGitDiffProvider(repoRoot: string): DiffProvider {
  return {
    async collectChangedFiles({ baseRef, includeUntracked }) {
      // Step 1 — get the name-status list.
      const r = execGit(repoRoot, ['diff', '--name-status', '--no-renames', baseRef]);
      if (!r.ok) return [];
      const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      const out: DiffEntry[] = [];
      for (const line of lines) {
        const [status, filePath] = line.split(/\s+/, 2);
        if (!filePath) continue;
        const norm = filePath.replace(/^"|"$/g, '');
        const abs = path.join(repoRoot, norm);
        let beforeText: string | undefined;
        let afterText: string | undefined;
        if (status !== 'A') {
          const show = execGit(repoRoot, ['show', `${baseRef}:${norm}`]);
          if (show.ok) beforeText = show.stdout;
        }
        if (status !== 'D' && fs.existsSync(abs)) {
          try {
            afterText = fs.readFileSync(abs, 'utf8');
          } catch {
            // ignore
          }
        }
        let entryStatus: DiffEntry['status'] = 'modified';
        if (status === 'A') entryStatus = 'added';
        else if (status === 'D') entryStatus = 'deleted';
        out.push({ path: norm, status: entryStatus, beforeText, afterText });
      }
      if (includeUntracked) {
        const u = execGit(repoRoot, ['ls-files', '--others', '--exclude-standard']);
        if (u.ok) {
          const utracked = u.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
          for (const f of utracked) {
            const abs = path.join(repoRoot, f);
            let afterText: string | undefined;
            try { afterText = fs.readFileSync(abs, 'utf8'); } catch { /* ignore */ }
            out.push({ path: f, status: 'added', afterText });
          }
        }
      }
      return out;
    },
  };
}

import { minimatch } from 'minimatch';

export function filterByGlobs(entries: DiffEntry[], globs: string[]): DiffEntry[] {
  if (globs.length === 0) return [];
  return entries.filter((e) => globs.some((g) => minimatch(e.path, g, { dot: true })));
}
