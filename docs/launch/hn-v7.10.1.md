# HN post — claude-autopilot v7.10.1

## Title

**Show HN: Claude-Autopilot v7.10.1 — autonomous dev pipeline with risk-tiered review**

(80 chars. Names the project, anchors on the current release, communicates the load-bearing feature without overclaiming.)

## URL (for HN submit form)

```
https://github.com/axledbetter/claude-autopilot
```

## Body (HN-compatible plain text, ~3,000 chars, fits under the 4,000 limit)

Paste this as the "text" field in HN's submit form. HN renders no markdown. Blank lines separate paragraphs. URLs become clickable automatically. Indented blocks render as monospace.

```
claude-autopilot is an MIT-licensed npm package that runs Claude Code through an autonomous pipeline: brainstorm, spec, plan, implement, migrate, validate, PR, review, bugbot. Point it at an idea, walk away, come back to a PR that's review-ready. Merge stays human-gated by default.

Try it in 30 seconds:

  npm install -g @delegance/claude-autopilot
  claude-autopilot examples              # list 5 starter stacks
  claude-autopilot examples node > spec.md
  claude-autopilot autopilot spec.md     # ship it

Five bundled stack templates (node, python, fastapi, go-cli, rust-cli) so you don't write your first spec from a blank page.

The strongest credibility signal I can give you: claude-autopilot built itself. Every version of this project that ever shipped, including v7.10.1 today, went through the pipeline you'll see on GitHub. Spec, plan, implementation subagents, Codex review, bugbot triage, admin-merge, npm publish. Full commit history and review threads preserved on the repo. No marketing, just the receipts.

I also use it daily on a production codebase. Several hundred thousand lines of code merged per week sustained, with one week peaking over a million. That's gross churn across feature code, tests, types, and migrations, mostly via the autopilot pipeline. The CLI is solving real problems for me before it ships to anyone else.

What's actually distinctive:

1. Multi-model role split, by default. Claude writes code, Codex reviews the plan and the diff, Cursor bugbot triages PR findings. Each model gets the job it's actually best at. Sequential by default. Opt-in parallel council (claude-autopilot council) dispatches the same prompt to Claude + Codex + Gemini and synthesizes consensus.

2. Every phase is an editable markdown skill. Not a black-box pipeline. .claude/skills/autopilot/SKILL.md is plain markdown you can read in 5 minutes, audit, edit, swap any phase. The risk-tiered review policy (1/2/3 Codex passes by spec risk frontmatter, auto-escalated for auth, multi-tenancy, billing, secrets, migrations, RLS, IAM) lives there as plain instructions. Inspectability is the wedge against Devin and Cursor agent mode.

3. Local CLI, your provider keys. Anthropic, OpenAI, Google, Groq, Ollama-local. The orchestration runs on your machine. Prompts go to whichever models you've configured. For pure local-only you need Claude Code itself on a local provider; for most teams the goal is "no hosted orchestration plus existing keys."

Benchmark on a Next.js fixture seeded with 13 production-realistic bugs (SQL injection, missing auth, IDOR, SSRF, open redirect, TOCTOU race, console.log in prod, missing input validation, etc): scan caught 13/13 in 38 seconds for $0.21. Fixture and reproduction in the repo.

Links:
https://www.npmjs.com/package/@delegance/claude-autopilot
https://github.com/axledbetter/claude-autopilot

I'm Alex, founding eng at Delegance (insurance brokerage platform). Built claude-autopilot for my own internal use, open-sourced when it started shipping itself. Happy to dig into the architecture, the role split, the editable skill model, the retry-loop sameness detector, or what I'd do differently.
```

---

## OP first comment (post immediately after submitting)

HN convention is to leave an OP first comment that adds detail the body couldn't fit. Paste this as the first reply to your own submission:

```
A few framing notes since the body had to fit under 4,000 chars:

On the volume number. "Several hundred thousand LOC per week sustained, with peaks over a million" is gross churn (insertions + deletions) across feature code, tests, generated types, lockfile updates, and migrations. Net new shippable code is a smaller fraction. The point isn't raw LOC; it's that the pipeline can sustainably operate on a real production codebase at that throughput, not a toy.

On stacks supported. The pipeline orchestrates whatever your project uses. Migration adapters cover Rails (Active Record), Alembic, Django, Prisma, Drizzle, golang-migrate, dbmate, flyway, supabase-cli, ecto, and typeorm; falls back to a configurable shell command for anything else. Deploy adapters cover Vercel, Fly, Render, and a generic shell adapter. Validate runs whatever test/lint/typecheck command you configure (npm test, pytest, go test, anything). Monorepo support auto-detects npm/yarn/pnpm workspaces, Turborepo, and Nx. Review engine adapters cover Claude, Gemini, Codex, and any OpenAI-compatible endpoint (Groq, Ollama, Together).

Why this vs Devin or Cursor agent mode. Devin is hosted, opaque, per-ACU billed, single-vendor stack. claude-autopilot runs locally, every phase is an editable skill, you bring your own provider keys, MIT-licensed. Cursor agent mode is a single-shot in-IDE loop. claude-autopilot sits one layer higher: spec review, implementation dispatch, validation, PR review, release workflow, retry-loop progress detection.

Closest cousins. Aider, OpenHands, SWE-agent. We share the local-CLI plus user's-key philosophy and add the phase pipeline, multi-model role split, risk-tiered review, and the retry-loop sameness detector (halts the pipeline when retries make no progress instead of burning the retry budget on attempts going nowhere).

See it work, with numbers:
- DEMO.md walks through one autonomous run, 12 minutes wall clock, $2.20 spend, 5 new tests:
  https://github.com/axledbetter/claude-autopilot/blob/master/DEMO.md
- Benchmark: 13/13 production-realistic bugs caught in 38 seconds for $0.21, reproducible:
  https://github.com/axledbetter/claude-autopilot#benchmark

Happy to dig into any of it.
```

---

## Anticipated comments + responses

| Comment | Response |
|---|---|
| "Several hundred thousand LOC/week? Sounds inflated." | Honest framing: gross churn including generated artifacts (types, lockfiles, migrations) and tests, not net new feature code. The point is the pipeline operates sustainably at that throughput on a real production codebase, not the raw number. Happy to share `git log --shortstat` excerpts. |
| "Why not just use Aider/Cursor/Continue?" | Different layer. Aider/Cursor/Continue optimize for interactive coding loops. claude-autopilot sits one layer up: spec review, dispatch, validation, PR review, release workflow, retry-loop progress detection. Use both — Aider in the editor for tight loops, autopilot for end-to-end ship cycles. |
| "How is this safer than letting an LLM run wild?" | Two human gates: (1) the spec is committed and reviewed before any agent dispatches, (2) the merge step requires human sign-off by default. The pipeline doesn't auto-merge. Plus the retry-loop sameness detector halts when retries stop making progress. |
| "What's the failure mode when Codex disagrees with itself?" | Risk-tiered policy: low-risk changes get 1 Codex pass, medium 2, high 3. Each pass with a remediation cycle between. CRITICAL findings auto-applied. WARNING auto-applied unless they contradict locked spec requirements. NOTE = discretionary. Human can intervene at any review boundary. |
| "Show me the actual cost." | Range: $0.21 (the 13-bug scan benchmark) to ~$15 (a full v7.x release loop with multiple Codex passes and 1700+ tests). Numbers from provider billing, not theoretical. |
| "Why Claude Code specifically?" | Skill model + plugin distribution. As Claude Code grows, autopilot rides that adoption — same install path as any other skill. We don't ship a competing IDE; we ship `/autopilot`. |
| "Does it work without Anthropic keys?" | The review layer does — adapter supports Claude, Gemini, Codex, and OpenAI-compatible (Groq, Ollama, Together). The full pipeline needs Claude Code (which needs Anthropic). |
| "What about the retry loop just retrying forever?" | v7.10.0 sameness detector — failure fingerprint comparison before each retry. Two identical fingerprints in a row halts the loop and surfaces it. Available as a public subpath import (`@delegance/claude-autopilot/run-state/sameness-detector`) for embedding into your own retry loops. |

---

## Pre-launch checklist

Run these in order before submitting. The post claims numbers and features that must verify within 30 seconds of someone clicking through, or the credibility loss is catastrophic.

1. **Verify all links resolve.**
   - `https://www.npmjs.com/package/@delegance/claude-autopilot` shows v7.10.1 as `latest`
   - `https://github.com/axledbetter/claude-autopilot` repo loads, README is current
   - `https://github.com/axledbetter/claude-autopilot/blob/master/DEMO.md` loads
   - `https://github.com/axledbetter/claude-autopilot#benchmark` anchor resolves

2. **Run the benchmark fresh.**

   ```bash
   npm install -g @delegance/claude-autopilot@latest
   # Re-seed the 13-bug fixture per README instructions
   ANTHROPIC_API_KEY=... claude-autopilot scan --all
   ```

   Confirm the 13/13 result, capture the cost + time numbers, and update the post body if they've drifted from $0.21 / 38s.

3. **Confirm DEMO.md is current.** Open DEMO.md, confirm the run it documents still works against the latest version (or note in the post that DEMO was captured on an earlier version, here's what's changed since).

4. **Check npm view output.**

   ```bash
   npm view @delegance/claude-autopilot version dist-tags.latest
   ```

   Confirm `version` is `7.10.1` and `dist-tags.latest` is `7.10.1`. If anything else is `latest`, abort and fix the publish before posting.

5. **Check GitHub topics.**

   ```bash
   gh api repos/axledbetter/claude-autopilot --jq .topics
   ```

   Should include `claude-code`, `coding-agent`, `autonomous-coding`, `multi-model-llm`, `devin-alternative`, `cursor-alternative` and the rest of the v7.10.x SEO set.

6. **Stash the volume-claim defense.** "Several hundred thousand LOC/week sustained" will get challenged. Have `git log --since=6.weeks --shortstat | awk` output ready locally so you can paste it into a comment if pressed. The honest range is 70k-1.2M per week with average ~190k-394k depending on whether you include a 1.2M outlier week.

---

## Timing

Tuesday-Thursday, 8-10 AM Pacific (11 AM-1 PM ET). Anchor on a shipped release — do not post until v7.10.1 is `latest` on npm AND the pre-launch checklist is complete.

---

## Risk notes

The "merge stays human-gated by default" framing is the load-bearing piece of this post's honesty. If HN frames this as "Alex let an LLM auto-merge to main," the conversation goes badly. The body and the responses table both reinforce that merge is human-gated. Stick to that frame.

The "claude-autopilot built itself" claim is the strongest credibility signal but also the most pressure-testable. Be ready to point at specific PRs in the repo where the entire merge history is autopilot-generated (v7.9.0, v7.9.1, v7.10.0, v7.10.1 are all good examples), and to walk through one start-to-finish if someone asks.

The volume number ("several hundred thousand LOC/week") will be challenged. Frame it as gross churn including generated artifacts the first time it comes up; offer to share raw `git log --shortstat` if pressed.
