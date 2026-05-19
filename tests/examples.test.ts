// v7.7.1 — Tests for the `examples` verb (5 stack templates).
//
// The brief covers 5 cases:
//   1. runExamples() with no args lists all 5 stacks
//   2. runExamples('node') prints only the node example
//   3. runExamples('python') prints only python
//   4. runExamples('unknown') exits 1 with a helpful error listing valid stacks
//   5. Each example file exists at examples/specs/<stack>.md

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXAMPLE_STACKS,
  EXAMPLE_STACK_IDS,
  resolveExamplePath,
  runExamples,
} from '../src/cli/examples.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Captured = { stdout: string; stderr: string };

/**
 * Capture process.stdout + process.stderr writes around `fn`. We deliberately
 * patch `process.stdout.write` rather than redirect fds because the
 * implementation uses both `console.log` (writes to stdout) AND
 * `process.stdout.write` for the body of a single-stack print.
 */
function captureIO(fn: () => number): Captured & { code: number } {
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  let stdout = '';
  let stderr = '';
  process.stdout.write = ((chunk: unknown) => {
    stdout += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = fn();
    return { stdout, stderr, code };
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  }
}

describe('examples verb', () => {
  it('E1: runExamples() with no args lists all 5 stacks', () => {
    const { stdout, code } = captureIO(() => runExamples());
    assert.equal(code, 0);
    // Every stack id appears in the listing (bolded heading per card).
    for (const id of EXAMPLE_STACK_IDS) {
      assert.ok(
        stdout.includes(id),
        `listing missing stack "${id}". Got:\n${stdout.slice(0, 800)}`,
      );
    }
    // The intro line / piping hint is present so users know how to use it.
    assert.ok(
      /Pass\s+`?examples\s+<stack>`?/i.test(stdout),
      `listing missing the "pass examples <stack>" hint. Got:\n${stdout.slice(0, 400)}`,
    );
  });

  it('E2: runExamples("node") prints only the node example', () => {
    const { stdout, code } = captureIO(() => runExamples('node'));
    assert.equal(code, 0);
    // Title line from node-cli.md.
    assert.ok(
      stdout.includes('Node 22 ESM CLI'),
      `node spec body missing title. Got:\n${stdout.slice(0, 400)}`,
    );
    // The `## Files` section is what the scaffolder reads — must be present.
    assert.ok(
      /^##\s+Files\s*$/m.test(stdout),
      `node spec body missing "## Files" section. Got:\n${stdout.slice(0, 400)}`,
    );
    // Cross-stack leakage check: the Python spec's `pyproject.toml` line
    // must NOT appear when the user asks for `node`.
    assert.ok(
      !/pyproject\.toml/.test(stdout),
      `node spec leaked python content (pyproject.toml).`,
    );
  });

  it('E3: runExamples("python") prints only python', () => {
    const { stdout, code } = captureIO(() => runExamples('python'));
    assert.equal(code, 0);
    assert.ok(
      stdout.includes('pyproject.toml'),
      `python spec body missing pyproject.toml. Got:\n${stdout.slice(0, 400)}`,
    );
    // Cross-stack leakage check: must NOT contain Node's bin entry.
    assert.ok(
      !/bin\/url-summarizer/.test(stdout),
      `python spec leaked node content.`,
    );
    // The bare python spec doesn't depend on FastAPI — it's the
    // framework-agnostic CLI template. (One contrastive mention of
    // "No FastAPI" in the Goal is fine; the dep itself must be absent.)
    assert.ok(
      !/uvicorn/i.test(stdout),
      `python spec leaked fastapi-specific dependency (uvicorn).`,
    );
  });

  it('E4: runExamples("unknown") exits 1 with a helpful error listing valid stacks', () => {
    const { stderr, code } = captureIO(() => runExamples('totallymadeupstack'));
    assert.equal(code, 1, `expected exit 1 for unknown stack, got ${code}. stderr:\n${stderr}`);
    assert.ok(
      /unknown stack/i.test(stderr),
      `expected "unknown stack" in stderr. Got:\n${stderr}`,
    );
    // The error must list the valid stack ids so the operator can recover.
    for (const id of EXAMPLE_STACK_IDS) {
      assert.ok(
        stderr.includes(id),
        `unknown-stack error missing valid stack "${id}" in its list. Got:\n${stderr}`,
      );
    }
  });

  it('E5: each example spec file exists on disk at the expected path', () => {
    for (const id of EXAMPLE_STACK_IDS) {
      const rel = EXAMPLE_STACKS[id];
      assert.ok(rel, `EXAMPLE_STACKS missing entry for "${id}"`);
      const abs = path.join(ROOT, rel);
      assert.ok(
        fs.existsSync(abs),
        `expected bundled example file at ${abs} (stack: ${id})`,
      );
      // Each spec must include a `## Files` section so it's actually usable
      // as a scaffolder input — otherwise `scaffold --from-spec` exits 2.
      const body = fs.readFileSync(abs, 'utf8');
      assert.ok(
        /^##\s+Files\s*$/im.test(body),
        `example spec ${rel} is missing the "## Files" section.`,
      );
      // Each spec must also have a `## How to use` section so a human
      // reading the file knows the 2-step recipe.
      assert.ok(
        /^##\s+How to use\s*$/im.test(body),
        `example spec ${rel} is missing the "## How to use" section.`,
      );
      // Sanity: resolveExamplePath() returns the same absolute path.
      assert.equal(resolveExamplePath(id), abs);
    }
  });
});
