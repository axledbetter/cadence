# url-summarizer — Node 22 ESM CLI

## Goal

A small Node 22 ESM CLI that takes a URL on the command line, fetches
the page, calls an LLM for a 3-bullet markdown summary, and prints the
result to stdout. Demonstrates the v7.1.6 benchmark layout: a thin
`bin/` entry that imports a pure handler from `src/`, JS-only with
`tsconfig.json` set up for `allowJs + checkJs + noEmit` typechecking.

This is the simplest scaffold target — it lights up the Node ESM path
in `claude-autopilot scaffold --from-spec`.

## Files

* `package.json` — Node 22 ESM, `type: "module"`, bin: { url-summarizer: bin/url-summarizer.js }, scripts: { test: "node --test --import=tsx tests/", typecheck: "tsc --noEmit" }
* `tsconfig.json` — `allowJs + checkJs + noEmit`, `types: ["node"]`
* `.gitignore` — `node_modules/`, `.env.local`, `.guardrail-cache/`
* `bin/url-summarizer.js` — CLI entry; parses `argv`, calls handler, prints result
* `src/handler.js` — Pure async function `summarize(url): Promise<string>` (fetch + LLM call)
* `tests/handler.test.js` — Unit tests with mocked fetch + LLM
* `tests/cli.test.js` — CLI subprocess tests (uses `child_process.spawn`, NOT `spawnSync`)
* `README.md` — Usage example: `node bin/url-summarizer.js https://example.com`

## How to use

```bash
claude-autopilot scaffold --from-spec examples/specs/node-cli.md
npm test
```

The scaffolder writes a working skeleton; you (or your impl agent) fill
in the handler body. The pre-existing tests should fail until the
handler is implemented — that's intentional, it gives the impl agent a
clear target.
