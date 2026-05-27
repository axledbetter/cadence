// src/core/autopilot/probes.ts
//
// Production probe implementations for `resume-verifier.ts`. Each function
// is a thin wrapper around fs / git / gh — they are intentionally NOT used
// in tests (tests inject stubs that match the VerifierProbes interface).
//
// Plan: docs/superpowers/plans/2026-05-27-autopilot-run-state-integration.md

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { runSafe } from '../shell.ts';
import type { VerifierProbes } from './resume-verifier.ts';

/** Construct the default production probes. */
export function makeProductionProbes(): VerifierProbes {
  return {
    fileExists(path: string): boolean {
      try {
        return fs.statSync(path).isFile();
      } catch {
        return false;
      }
    },

    fileSha(path: string): string {
      const buf = fs.readFileSync(path);
      return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
    },

    gitWorktreeList(repoRoot: string): { path: string; branch: string }[] {
      const raw = runSafe('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']);
      if (!raw) return [];
      const out: { path: string; branch: string }[] = [];
      let cur: { path?: string; branch?: string } = {};
      for (const line of raw.split('\n')) {
        if (line.startsWith('worktree ')) {
          if (cur.path && cur.branch) out.push({ path: cur.path, branch: cur.branch });
          cur = { path: line.slice('worktree '.length) };
        } else if (line.startsWith('branch ')) {
          // "branch refs/heads/foo" → keep just the short name
          const ref = line.slice('branch '.length);
          cur.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
        } else if (line.length === 0 && cur.path && cur.branch) {
          out.push({ path: cur.path, branch: cur.branch });
          cur = {};
        }
      }
      if (cur.path && cur.branch) out.push({ path: cur.path, branch: cur.branch });
      return out;
    },

    gitRevParseHead(worktreePath: string): string {
      const raw = runSafe('git', ['-C', worktreePath, 'rev-parse', 'HEAD']);
      if (!raw) throw new Error(`git rev-parse HEAD failed in ${worktreePath}`);
      return raw.trim();
    },

    gitStatusPorcelain(worktreePath: string): string {
      const raw = runSafe('git', ['-C', worktreePath, 'status', '--porcelain=v2']);
      if (raw === null) throw new Error(`git status failed in ${worktreePath}`);
      return raw.trim();
    },

    async migrationLogContains(_id: string): Promise<{ found: boolean; checksum?: string }> {
      // STUB — until the cadence_migration_log table schema lands.
      // Per spec post-launch follow-up. The verifier's migrate path treats
      // { found: false } as "needs-human", which is the correct
      // fail-closed behavior. NEVER auto-skip a migration on resume.
      return { found: false };
    },

    async ghPrView(num: number): Promise<{ headRefName: string; mergedAt: string | null } | null> {
      const raw = runSafe('gh', [
        'pr', 'view', String(num),
        '--json', 'headRefName,mergedAt',
      ]);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as { headRefName?: string; mergedAt?: string | null };
        if (typeof parsed.headRefName !== 'string') return null;
        return {
          headRefName: parsed.headRefName,
          mergedAt: typeof parsed.mergedAt === 'string' ? parsed.mergedAt : null,
        };
      } catch {
        return null;
      }
    },

    async ghPrComment(prNumber: number, commentId: string): Promise<{ exists: boolean }> {
      const raw = runSafe('gh', [
        'api', `repos/{owner}/{repo}/pulls/${prNumber}/comments`,
      ]);
      if (!raw) return { exists: false };
      try {
        const parsed = JSON.parse(raw) as { id?: number | string }[];
        if (!Array.isArray(parsed)) return { exists: false };
        const idStr = String(commentId);
        return { exists: parsed.some(c => String(c.id) === idStr) };
      } catch {
        return { exists: false };
      }
    },
  };
}
