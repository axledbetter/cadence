# HN post — claude-autopilot v7.10.0

## Title (use this one)

**Show HN: Claude-Autopilot v7.10.0 — autonomous dev pipeline with risk-tiered review**

(76 chars. Names the project, anchors on the latest release, communicates
the load-bearing feature without overclaiming. Alternates kept for
reference at the bottom of this file.)

## Body

```
claude-autopilot is an npm package (MIT, fully open source) that runs
Claude Code through an autonomous pipeline: brainstorm → spec → plan →
implement → migrate → validate → PR → review → bugbot. You point it at
an idea, walk away, and come back to a PR that's review-ready (merge
stays human-gated by default).

I ship it under @delegance/claude-autopilot. v7.10.0 went out today.
Three things have landed since I last posted here:

- v7.9.0 — merged autopilot skill. One skill drives the whole
  idea-to-PR flow, and review depth is risk-tiered: specs declare
  `risk: low | medium | high` in frontmatter, the pipeline runs
  1 / 2 / 3 sequential Codex passes accordingly, each with a
  remediation cycle in between.
- v7.9.1 — migrate sequencing correctness. Validate runs before
  migrate; no more phantom "auto-promote on red CI" claims. The skill
  promotes dev → QA → prod only when each prior env is green.
- v7.10.0 — retry-loop sameness detector. Validate / Codex / bugbot
  retry loops compute a failure fingerprint before consuming each
  retry. If the same fingerprint fires twice in a row, the pipeline
  halts and surfaces it to you — instead of burning the remaining
  retry budget on attempts that are making no progress. Shipped as
  a public subpath import for embedding into your own retry loops.

## Three things only this product gives you

1. **No hosted workspace, no remote sandbox.** Your repo stays on
   your machine. No third-party agent runtime, no SaaS-side
   orchestration, no per-seat markup. Prompts (diffs, file context,
   design questions) go to whichever LLM providers you've configured
   (Anthropic / OpenAI / Google / Groq / Ollama-local). For a truly
   local-only setup you must point _every_ model in the execution
   path at a local endpoint — including the Claude Code agent runtime
   itself. For most teams "local-only" isn't the goal; "no hosted
   orchestration + your existing provider keys" is.

2. **Risk-tiered review depth, policy-driven.** Auto-escalation by
   keyword detection for sensitive categories (auth, multi-tenancy,
   billing, secrets, migrations, RLS, deploy/IAM, vector-DB tenancy).
   Enforcement is encoded in `.claude/skills/autopilot/SKILL.md` as
   an editable LLM instruction set, not a hard CLI gate, so you can
   audit it, swap the tier rules, expand the keyword list. Designed
   for teams that want review depth to scale with change risk
   instead of running forensic-grade review on every typo.

3. **Ships as a Claude Code skill, not a competing IDE.**
   `/brainstorm`, `/autopilot`, `/migrate`, `/validate` are
   first-class Claude Code commands. As Claude Code grows, autopilot
   rides that adoption. You don't switch tools to use it; it's
   already there.

Plus a fourth: **multi-model council, available as a verb.**
`claude-autopilot council` dispatches the same diff or design
question to Claude + Codex + Gemini in parallel and synthesizes the
consensus. It's opt-in — the default pipeline uses sequential Codex
review (cheaper, faster, often sufficient for routine changes). Wire
council into the autopilot pipeline by editing Step 7 of the skill,
or invoke standalone for one-off design decisions.

## Why this vs Devin / Cursor agent mode

- **Devin** is hosted, opaque, per-ACU billing, single-model stack.
  claude-autopilot runs locally, every phase is an editable skill,
  you bring your own provider keys, MIT-licensed.
- **Cursor agent mode** is a single-shot in-IDE loop. claude-autopilot
  sits one layer higher: spec review, implementation dispatch,
  validation, PR review, release workflow, retry-loop progress
  detection. Different layer of the stack.
- **Aider / OpenHands / SWE-agent** are closer cousins — local CLI,
  user's API key. claude-autopilot adds the phase pipeline + the
  multi-model role split (Claude writes code, Codex reviews the
  plan, bugbot triages PR findings — swap any of them).

## Demo + benchmark

- DEMO.md walks through one real autonomous run on a Python codebase:
  12 minutes wall clock, $2.20 spend, 5 new tests, multi-file
  integration, zero manual intervention. Honest about what's
  bounded today.
- Benchmark: on a Next.js fixture seeded with 13 production-realistic
  bugs (SQL injection, hardcoded secret, missing auth, IDOR, CORS
  wildcard, SSRF, open redirect, TOCTOU race, silent error swallow,
  off-by-one, missing rate limit, console.log in prod, missing input
  validation), `claude-autopilot scan --all` with Claude Opus caught
  13/13 in 38 seconds for $0.21. Reproducible — fixture lives in the
  repo, full instructions in the README.

Links:
- npm: https://www.npmjs.com/package/@delegance/claude-autopilot
- repo: https://github.com/axledbetter/claude-autopilot
- DEMO: https://github.com/axledbetter/claude-autopilot/blob/master/DEMO.md

I'm Alex, founding eng at Delegance (insurance brokerage platform).
I built claude-autopilot for my own internal use, then OSSed it
when it kept saving hours per day. Happy to answer technical
questions about the pipeline architecture, the codex-review loop,
the sameness detector, or what I'd do differently.
```

---

## OP first comment (post immediately after submitting)

HN convention is to leave an OP first comment that frames the
project and answers the obvious "why this not X" upfront. Paste
this as the first reply to your own submission:

```
A few framing notes since "another coding agent" is a fair first
reaction:

**On open-source / local-orchestration.** The CLI is MIT and runs
on your machine. No hosted agent runtime, no SaaS-side
orchestration, no per-seat markup. Prompts go to whichever
provider keys you've configured (Anthropic, OpenAI, Google, Groq,
Ollama). For most teams the goal isn't pure local-only — it's "no
hosted orchestration + your existing provider keys." That's what
this is.

**On multi-model per role.** Claude writes code, Codex reviews the
plan, bugbot triages PR findings. The role split is the thing —
each model gets the job it's actually best at. You can swap any
of them, or invoke `claude-autopilot council` to dispatch the same
prompt to Claude + Codex + Gemini in parallel and synthesize.

**On why this is different from Devin / Cursor agent mode.**
Devin = hosted, opaque, per-ACU, vendor stack. Cursor agent mode =
single-shot in-IDE loop. claude-autopilot sits one layer higher:
spec review, dispatch, validation, PR review, release workflow,
retry-loop progress detection. Skill-per-phase, all state on disk,
every phase rewireable in plain markdown.

**Closest cousins.** Aider / OpenHands / SWE-agent. We share the
local-CLI + user's-key philosophy; we add the phase pipeline + the
multi-model role split + risk-tiered review depth + the retry-loop
sameness detector.

**See it work, with numbers:**
- DEMO.md — one real autonomous run, 12 min, $2.20:
  https://github.com/axledbetter/claude-autopilot/blob/master/DEMO.md
- Benchmark — 13/13 bugs caught in 38s for $0.21, reproducible:
  https://github.com/axledbetter/claude-autopilot#benchmark

Happy to dig into any of it.
```

---

## Anticipated comments + responses

| Comment | Response |
|---|---|
| "Why not just use Aider/Cursor/Continue?" | Aider/Cursor/Continue optimize for interactive coding loops. claude-autopilot sits one layer higher: spec review, implementation dispatch, validation, PR review, release workflow, retry-loop progress detection. Different layer of the stack. |
| "How is this safer than letting an LLM run wild?" | Two human gates: (1) the spec is committed + reviewed before any agent dispatches, and (2) the merge step requires human sign-off by default. The pipeline doesn't auto-merge. Plus the retry-loop sameness detector halts when retries stop making progress, so you don't burn budget on attempts going nowhere. |
| "What's the failure mode when codex disagrees with itself?" | Risk-tiered policy: low-risk changes get 1 codex pass, medium 2, high 3. Each pass with a remediation cycle in between. CRITICAL findings auto-applied. WARNING auto-applied unless they contradict locked spec requirements. NOTE = discretionary. Human can intervene at any review boundary. |
| "Show me the actual cost." | Range: $0.21 (the 13-bug scan benchmark) to ~$15 (a full v7.x release loop with multiple Codex passes and 1700+ tests). Numbers from provider billing, not theoretical. |
| "Can I see a real run?" | DEMO.md walks through one autonomous run end-to-end with cost numbers. Every v7.x release PR in the repo is a self-eat demo — pipeline shipped its own release, full commit history and Codex reviews preserved. |
| "Why Claude Code specifically?" | Skill model + plugin distribution. As Claude Code grows, autopilot rides that adoption — same install path as any other skill. We don't ship a competing IDE; we ship `/autopilot`. |
| "Does it work without Anthropic keys?" | The review layer does — adapter supports Claude, Gemini, Codex, OpenAI-compatible (Groq, Ollama, Together). The full pipeline needs Claude Code (which needs Anthropic). v8 work tracks broader provider support for the orchestration layer. |
| "What about the retry loop just retrying forever?" | v7.10.0 sameness detector — failure fingerprint comparison before each retry. Two identical fingerprints in a row halts the loop and surfaces it. Available as a public subpath import (`@delegance/claude-autopilot/run-state/sameness-detector`) for embedding into your own retry loops. |

---

## Pre-launch checklist

Run these in order before submitting. The post claims numbers and
features that must verify within 30 seconds of someone clicking
through, or the credibility loss is catastrophic.

1. **Verify all links resolve.**
   - `https://www.npmjs.com/package/@delegance/claude-autopilot` shows v7.10.0 as `latest`
   - `https://github.com/axledbetter/claude-autopilot` repo loads, README is current
   - `https://github.com/axledbetter/claude-autopilot/blob/master/DEMO.md` loads
   - `https://github.com/axledbetter/claude-autopilot#benchmark` anchor resolves

2. **Run the benchmark fresh.**
   ```bash
   npm install -g @delegance/claude-autopilot@latest
   # Re-seed the 13-bug fixture per README instructions
   ANTHROPIC_API_KEY=... claude-autopilot scan --all
   ```
   Confirm the 13/13 result, capture the cost + time numbers, and
   update the post body if they've drifted from $0.21 / 38s.

3. **Confirm DEMO.md is current.**
   Open DEMO.md, confirm the run it documents still works against
   the latest version (or note in the post that DEMO was captured
   on an earlier version, here's what's changed since).

4. **Check npm view output.**
   ```bash
   npm view @delegance/claude-autopilot version dist-tags.latest dist.unpackedSize dist.fileCount
   ```
   Confirm `version` is `7.10.0` and `dist-tags.latest` is `7.10.0`.
   If anything else is `latest`, abort and fix the publish before
   posting.

5. **Check GitHub topics.**
   ```bash
   gh api repos/axledbetter/claude-autopilot --jq .topics
   ```
   Should include `claude-code`, `coding-agent`, `autonomous-coding`,
   `multi-model-llm`, `devin-alternative`, `cursor-alternative` and
   the rest of the v7.10.0 SEO set. If empty, run the topics-update
   command (see `docs/launch/topics.md` or session notes) before
   posting — HN traffic will hit the GitHub repo, topics drive
   GitHub search discovery in the hours after launch.

6. **Pin benchmark evidence to an immutable artifact.**
   The post cites "13/13 in 38s for $0.21" (benchmark) and "12 min,
   $2.20" (DEMO). Those link to mutable `master` paths today. Before
   posting, capture a freshly run benchmark to a committed file —
   suggested `docs/benchmarks/v7.10.0.md` — with package version,
   git commit SHA, model name + provider, exact command, elapsed
   time, cost source (provider billing console vs `--json` token
   counts), and raw output summary. Update the HN draft to link
   that file. If you skip this step, be prepared to be challenged
   on the numbers in the comments — have the raw run output
   stashed locally and be ready to paste.

---

## Timing

Tuesday-Thursday, 8-10 AM Pacific. Anchor on a shipped release —
do not post until v7.10.0 is `latest` on npm AND the pre-launch
checklist is complete. The numbers in the post must verify from
the npm page within 30 seconds of clicking through.

---

## Alternate titles (for reference)

- "Show HN: claude-autopilot — autonomous Claude Code pipeline with risk-tiered review" (78 chars)
- "Show HN: claude-autopilot v7.10 — skill-based autonomous dev pipeline" (68 chars)
- "Show HN: An autonomous dev pipeline that halts when retries stop progressing" (76 chars — leads with the v7.10 hook)

---

## Risk note

The "merge stays human-gated by default" framing is the load-bearing
piece of this post's honesty. If HN frames this as "Alex let an LLM
auto-merge to main", the conversation goes badly. The body and the
responses table both reinforce that merge is human-gated. Stick to
that frame.

The risk-tiered review claim is also load-bearing. Be ready to
point at `.claude/skills/autopilot/SKILL.md` and walk through the
tier rules if someone challenges "is this real or marketing."
