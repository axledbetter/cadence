// v7.7.1 — `claude-autopilot examples [<stack>]`
//
// Discoverability bridge between `setup` and `scaffold --from-spec`. A new
// user runs `setup`, then `scaffold --from-spec ???` and has no idea what a
// spec looks like. This verb prints sample specs — one per supported stack —
// straight to stdout so the operator can pipe to a file, edit, and feed back
// into `scaffold`.
//
//   claude-autopilot examples                   → list all 5 stacks
//   claude-autopilot examples node              → print just the Node spec
//   claude-autopilot examples fastapi > foo.md  → spec-as-template via shell
//
// The spec files ship in the published tarball via the `files: ["examples/"]`
// entry in package.json. At runtime we resolve them relative to the package
// root (found by `findPackageRoot`), so `examples` works whether the CLI is
// run from source, the built dist/, or a globally installed `npm i -g`
// invocation.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { findPackageRoot } from './_pkg-root.ts';

/** Supported stack id → relative path under `examples/specs/`. */
export const EXAMPLE_STACKS: Record<string, string> = {
  node: 'examples/specs/node-cli.md',
  python: 'examples/specs/python-cli.md',
  fastapi: 'examples/specs/fastapi.md',
  go: 'examples/specs/go-cli.md',
  rust: 'examples/specs/rust-cli.md',
};

/** Public stack ids in the order we want them listed. */
export const EXAMPLE_STACK_IDS = ['node', 'python', 'fastapi', 'go', 'rust'] as const;

const BOLD = (t: string) => `\x1b[1m${t}\x1b[0m`;
const DIM = (t: string) => `\x1b[2m${t}\x1b[0m`;

/** Resolve the absolute on-disk path for a stack's spec file. */
export function resolveExamplePath(stack: string): string | null {
  const rel = EXAMPLE_STACKS[stack];
  if (!rel) return null;
  const root = findPackageRoot(import.meta.url);
  if (!root) return null;
  return path.join(root, rel);
}

/** Print the first N non-empty lines of a file for the listing summary. */
function previewHead(absPath: string, n: number): string {
  try {
    const body = fs.readFileSync(absPath, 'utf8');
    const lines = body.split('\n');
    const head: string[] = [];
    for (const line of lines) {
      head.push(line);
      if (head.length >= n) break;
    }
    return head.join('\n');
  } catch {
    return '(failed to read example file)';
  }
}

/**
 * Run the `examples` verb. With no `stack`, prints an intro + a summary card
 * for each stack (path + first ~5 lines of the spec). With a stack id, prints
 * the full spec content to stdout (suitable for piping into a file).
 *
 * Returns the exit code so the dispatcher can `process.exit(code)`.
 */
export function runExamples(stack?: string): number {
  if (!stack) {
    console.log('');
    console.log(BOLD('Sample specs for each supported stack.'));
    console.log(DIM('Pass `examples <stack>` to print just one. Pipe to a file to use as a template:'));
    console.log(DIM('  claude-autopilot examples node > docs/specs/my-feature.md'));
    console.log(DIM('  claude-autopilot scaffold --from-spec docs/specs/my-feature.md'));
    console.log('');
    for (const id of EXAMPLE_STACK_IDS) {
      const abs = resolveExamplePath(id);
      if (!abs || !fs.existsSync(abs)) {
        console.log(`${BOLD(id)}  ${DIM('(example file not found)')}`);
        console.log('');
        continue;
      }
      console.log(BOLD(id));
      console.log(DIM(`  ${abs}`));
      const head = previewHead(abs, 5);
      for (const line of head.split('\n')) {
        console.log(`  ${line}`);
      }
      console.log('');
    }
    return 0;
  }

  const abs = resolveExamplePath(stack);
  if (!abs) {
    process.stderr.write(
      `\x1b[31m[claude-autopilot] unknown stack "${stack}" — valid: ${EXAMPLE_STACK_IDS.join(', ')}\x1b[0m\n`,
    );
    return 1;
  }
  if (!fs.existsSync(abs)) {
    process.stderr.write(
      `\x1b[31m[claude-autopilot] example file missing on disk: ${abs}\x1b[0m\n`,
    );
    process.stderr.write(
      `\x1b[2m  Did the published tarball include the "examples/" directory? See package.json "files".\x1b[0m\n`,
    );
    return 1;
  }
  const body = fs.readFileSync(abs, 'utf8');
  process.stdout.write(body);
  if (!body.endsWith('\n')) process.stdout.write('\n');
  return 0;
}
