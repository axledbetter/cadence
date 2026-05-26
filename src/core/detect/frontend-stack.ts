// src/core/detect/frontend-stack.ts
//
// Detects the project's frontend component library + Tailwind presence + the
// canonical primitives directory. Mirrors the shape of src/core/detect/stack.ts
// (existing helper for the broader Go/Rust/Python/Node stack detection).
//
// Consumed by:
//   - scripts/audit-frontend.ts (informational; used in --help output and to
//     auto-populate themeFiles guidance for stack-aware playbook generation).
//   - Future: skills/frontend-impl-playbook/SKILL.md dispatcher integration.
//
// Detection precedence is fixed and documented — see the spec at
// docs/superpowers/specs/2026-05-26-issue-178-frontend-quality-design.md.

import * as fs from 'node:fs';
import * as path from 'node:path';

export type FrontendComponentLibrary =
  | 'shadcn'
  | 'mui'
  | 'chakra'
  | 'mantine'
  | 'antd'
  | 'bootstrap'
  | 'custom'
  | 'unknown';

export interface FrontendStack {
  library: FrontendComponentLibrary;
  hasTailwind: boolean;
  /** Repo-root-relative paths to detected tailwind config file(s). */
  tailwindConfigs: string[];
  /** Auto-detected primitives directory, repo-relative. Null if none found. */
  primitivesDir: string | null;
}

const TAILWIND_CONFIG_NAMES = [
  'tailwind.config.ts',
  'tailwind.config.js',
  'tailwind.config.mjs',
  'tailwind.config.cjs',
];

const PRIMITIVES_DIRS = [
  'app/components/ui',
  'src/components/ui',
  'components/ui',
];

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Collect dependency names across all relevant dep fields. Returns a Set so
 * lookups are O(1). Reads `dependencies`, `devDependencies`, and
 * `peerDependencies` — Codex pass-2 flagged that limiting to `dependencies`
 * misses real-world projects where the design system lives in devDeps.
 */
function collectDepNames(pkg: Record<string, unknown> | null): Set<string> {
  const out = new Set<string>();
  if (!pkg) return out;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const v = pkg[field];
    if (v && typeof v === 'object') {
      for (const name of Object.keys(v as Record<string, unknown>)) {
        out.add(name);
      }
    }
  }
  return out;
}

function hasAnyDep(deps: Set<string>, names: ReadonlyArray<string>): boolean {
  for (const n of names) {
    if (deps.has(n)) return true;
  }
  return false;
}

/**
 * Detect the frontend stack from a project directory.
 * Returns an object describing the detected library + Tailwind presence +
 * primitives directory. NEVER throws — missing/malformed files degrade to
 * `library: 'unknown'`.
 */
export function detectFrontendStack(cwd: string): FrontendStack {
  const pkg = readJson(path.join(cwd, 'package.json'));
  const deps = collectDepNames(pkg);

  // Tailwind config detection
  const tailwindConfigs: string[] = [];
  for (const name of TAILWIND_CONFIG_NAMES) {
    if (fs.existsSync(path.join(cwd, name))) {
      tailwindConfigs.push(name);
    }
  }
  const hasTailwind = tailwindConfigs.length > 0 || deps.has('tailwindcss');

  // Library detection precedence — first match wins.
  let library: FrontendComponentLibrary = 'unknown';
  if (fs.existsSync(path.join(cwd, 'components.json'))) {
    // shadcn marker file is canonical. Do NOT require a specific @radix-ui
    // dependency — Codex pass-2 noted that shadcn projects vary in which
    // primitives they install.
    library = 'shadcn';
  } else if (hasAnyDep(deps, ['@mui/material', '@mui/core'])) {
    library = 'mui';
  } else if (deps.has('@chakra-ui/react')) {
    library = 'chakra';
  } else if (deps.has('@mantine/core')) {
    library = 'mantine';
  } else if (deps.has('antd')) {
    library = 'antd';
  } else if (hasAnyDep(deps, ['bootstrap', 'react-bootstrap'])) {
    library = 'bootstrap';
  } else if (hasTailwind) {
    library = 'custom';
  } else {
    library = 'unknown';
  }

  // Primitives directory — first existing wins.
  let primitivesDir: string | null = null;
  for (const dir of PRIMITIVES_DIRS) {
    const abs = path.join(cwd, dir);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      primitivesDir = dir;
      break;
    }
  }

  return { library, hasTailwind, tailwindConfigs, primitivesDir };
}
