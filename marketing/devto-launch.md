---
title: "Cadence v8.4 — a multi-model coding harness where Claude writes, Codex reviews, and Bugbot triages"
published: false
tags: [opensource, ai, devops, javascript]
cover_image: ./marketing/demo.gif
description: "An open-source coding harness in the Devin/Aider/Goose category, with one twist: every phase of the SDLC runs on the model best suited for it. 16+ provider adapters, MIT licensed, runs on your machine."
---

Claude writes. Codex reviews. Bugbot triages. Gemini sits on the council.

Cadence is an open-source coding harness — same category as Devin, Cursor agents, Aider, and Goose — but with one structural bet: different SDLC roles run on different models. The model that writes the code is not the model that reviews it, and neither of them is the model that triages the bug report. You get to pick the model per phase, and the orchestration is just a YAML file you can edit.

I shipped v8.4.0 this week. Here's why the multi-model angle matters and what the harness actually does.

## The single-model problem

Most coding agents — including the well-funded ones — run the whole SDLC on one model. The same weights write the diff, review the diff, and decide whether the bug report is real. That's the equivalent of letting a junior engineer self-review their own PR and also decide which Sentry alerts to dismiss.

A model that wrote subtly broken code is statistically the worst model to catch the bug in it. They share the same blind spots — the same fencepost errors, the same favorite anti-patterns, the same overconfidence on the parts they got wrong. Tier-1 human teams don't review like this. The author writes. Someone else reviews. A third person triages production incidents. Different people, different cognitive frames, different incentives.

Cadence treats LLMs the same way. The author and the reviewer should be different models, ideally from different families, ideally trained on different data mixes.

## What Cadence does

Cadence is a pipeline of rewireable skills:

```
brainstorm -> spec -> plan -> implement -> migrate -> validate -> PR -> review -> bugbot -> merge
```

Each phase is a skill — a markdown contract plus a small amount of harness glue. Each phase can route to a different provider. The defaults I run:

- **brainstorm / spec** — Claude (Anthropic) for structured longform reasoning
- **implement** — Claude Sonnet for the writing pass
- **review** — GPT-5.5 / Codex for the adversarial pass on the diff
- **council** (optional) — Gemini, brought in for tie-breaks on architectural calls
- **bugbot triage** — Cursor's bugbot on the PR, then a model pass to classify each finding (real bug / false positive / low value) and either fix it or dismiss it with reasoning

The interesting failure modes the multi-model setup catches: Claude over-mocks tests, Codex catches it. Codex over-fixates on imaginary race conditions, Claude flags the false positive. Gemini disagrees with both about a schema decision, council resolves it. Nothing about this is magical — it's just three independent passes by models that don't share weights.

## Risk-tiered review depth

Every spec declares a risk tier in its frontmatter. The harness reads it and picks how many review passes to run before merge:

- **Low** — 1 review pass
- **Medium** — 2 passes
- **High** — 3 passes plus council

This is honest engineering ROI. A typo fix doesn't need three rounds of GPT-5.5. A migration that touches production tables does.

## Concurrent multi-PR dispatch

v7.11.0 shipped worktree isolation. You can run N specs in parallel — each in its own git worktree, each in its own Cadence session, each producing its own PR. I've shipped 4 PRs concurrently in one sitting without any cross-contamination. The harness handles the worktree lifecycle; you just point it at specs.

## 16+ providers

The provider adapter layer covers: Anthropic, OpenAI, Google (Gemini), Groq, Ollama, AWS Bedrock, Azure OpenAI, Cohere, Mistral, DeepSeek, Together, Fireworks, Perplexity, OpenRouter, xAI Grok, and any OpenAI-compatible endpoint you point it at. Every phase can be overridden in a profile:

```yaml
# .cadence/profile.yaml
phases:
  implement:
    provider: anthropic
    model: claude-sonnet-4-6
  review:
    provider: openai
    model: gpt-5.5
  council:
    provider: google
    model: gemini-2.5-pro
  bugbot_triage:
    provider: anthropic
    model: claude-haiku-4-5
```

Swap providers without touching skill code. If a new model lands tomorrow, change one line.

## Receipts

Cadence ships itself. Most v7.x and all of v8.x went through its own pipeline — spec written by Cadence, implemented by Cadence, reviewed by Cadence, bugbot-triaged by Cadence, merged by Cadence. You can browse the merged PRs here: https://github.com/axledbetter/cadence/pulls?q=is%3Apr+is%3Amerged

The dogfood is the test suite.

## Claude Code as a distribution surface

One housekeeping note: Cadence's skills load through Anthropic's Claude Code CLI as one of its distribution surfaces. You don't need to be a Claude Code user to care about the harness — the orchestration, the multi-model routing, the worktree dispatch, the bugbot triage are all provider-agnostic. Claude Code happens to be a convenient host for the skill loader. That's the whole relationship.

## Try it

```bash
npm install -g @delegance/cadence@latest
cadence autopilot examples/specs/node-cli.md
```

Repo: https://github.com/axledbetter/cadence

## License and footprint

MIT. Local-first. Runs on your machine with your API keys. No hosted agent, no telemetry, no per-seat subscription, no "contact sales." If your employer says you can run `npm install` and call provider APIs from your laptop, you can run Cadence.

If you've been waiting for an open-source coding harness that doesn't pretend a single model is good at every job, this is the one I built. Pull requests, issues, and skeptical takes all welcome.
