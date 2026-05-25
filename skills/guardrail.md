---
name: guardrail
description: (Legacy alias) LLM-powered code review — runs static rules + LLM review over git-changed files. As of v5, this is the review *phase* of Cadence (formerly claude-autopilot). Invoke via `cadence run` (or legacy `claude-autopilot run`) or the full pipeline via the `claude-autopilot` skill.
---

# guardrail — review phase (legacy alias)

As of `@delegance/claude-autopilot@5.0.0`, `guardrail` is the review phase of the full pipeline, not a standalone product. **Update for v8.0.0:** the package was further renamed to `@delegance/cadence` and the primary CLI bin is now `cadence`; `guardrail` and `claude-autopilot` remain as bin aliases through the v8.x line. This skill is preserved as a back-compat alias for Claude Code agents that were configured against v4.x.

**For new configurations**, invoke `skills/claude-autopilot.md` to drive the full pipeline, or use the flat review subcommands (`run`, `scan`, `ci`, etc.) for just the review phase. Grouped syntax (`claude-autopilot review <verb>`) lands in alpha.2.

## What it does

Static rules (`hardcoded-secrets`, `sql-injection`, `missing-auth`, `ssrf`, `insecure-redirect`, `npm-audit`, `package-lock-sync`, `console-log`, `todo-fixme`, `large-file`, `missing-tests`, `brand-tokens`, `schema-alignment`) run first, then an LLM reviewer (`claude`, `codex`, `gemini`, or `openai-compatible`) gets the code with context. Output is SARIF / JUnit / inline PR comments.

## When to use

- Before creating a PR — `claude-autopilot run --base main`
- To audit a path without git changes — `claude-autopilot scan src/auth/`
- To ask a targeted question — `claude-autopilot scan --ask "is there an IDOR here?" src/api/`
- Inside CI — `claude-autopilot ci`
- Dev loop — `claude-autopilot watch`

## Legacy commands that still work

All v4 `guardrail <cmd>` invocations work unchanged through v5.x. A one-line deprecation notice prints on first invocation per terminal session. Migration guide: `docs/migration/v4-to-v5.md`.

```bash
guardrail run --base main        # still works — equivalent to `claude-autopilot run --base main`
guardrail scan src/auth/         # still works
guardrail ci                     # still works
```

## What changed in v5

- `guardrail` is now one phase of a pipeline, not a standalone product.
- The full pipeline runs via the `claude-autopilot` skill or `claude-autopilot` CLI.
- Review subcommands remain flat in alpha.1 (`run`, `scan`, `ci`, `explain`, `fix`, `baseline`). The grouped `claude-autopilot review <verb>` syntax arrives in alpha.2 as an alias — flat forms will continue to work.
- The package is `@delegance/claude-autopilot` — the old `@delegance/guardrail` will be a thin tombstone forwarding to the new package in v5.0.0 GA.
