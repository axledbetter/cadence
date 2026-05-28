// src/core/schema-changes/artifact-resolver.ts
//
// Shared helper for finding the implement-phase artifact for the current
// workflow. Used by both `cadence validate` (policy enforcement) and
// `cadence pr-desc` (manifest injection) so both surfaces look at the
// SAME artifact (codex CRITICAL — fixes fail-open on mtime ordering).
//
// Resolution strategy:
//   1. Walk every directory under `.claude/autopilot/runs/<runId>/`.
//   2. For each, stat `artifacts/implement.json`. If it exists, record
//      the file's mtime (NOT the run-dir mtime — file mtime is monotonic
//      with the artifact's actual write).
//   3. Return the newest artifact path.
//
// If multiple concurrent runs are happening, the most recently written
// implement.json wins. The lifecycle layer guarantees that the artifact
// is only written by `endPhase('implement')` so the recency check is
// reliable.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ResolvedArtifact {
  runDir: string;
  artifactPath: string;
  mtimeMs: number;
}

export function findLatestImplementArtifact(cwd: string): ResolvedArtifact | null {
  const runsRoot = path.join(cwd, '.claude', 'autopilot', 'runs');
  if (!fs.existsSync(runsRoot)) return null;
  let best: ResolvedArtifact | null = null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const artifact = path.join(runsRoot, d.name, 'artifacts', 'implement.json');
    if (!fs.existsSync(artifact)) continue;
    try {
      const stat = fs.statSync(artifact);
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = { runDir: path.join(runsRoot, d.name), artifactPath: artifact, mtimeMs: stat.mtimeMs };
      }
    } catch {
      continue;
    }
  }
  return best;
}
