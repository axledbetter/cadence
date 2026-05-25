---
name: claude-autopilot
description: Autonomous development pipeline — brainstorm → spec → plan → implement → migrate → validate → PR → review → merge. Use when the user asks to "ship", "implement", "build", or "autopilot" a feature that's past the idea stage. Runs end-to-end without pausing for check-ins.
---

# claude-autopilot — Agent Loop

This skill drives the full claude-autopilot pipeline when a user asks Claude to ship a feature. It is an *agent loop*, not a CLI reference — the commands it invokes are an implementation detail. The skill's job is to decide which phase applies, when to pause for user approval, and when to recover from a failed phase.

## When to invoke

- User says "ship X", "implement X", "build X", "autopilot X", or hands Claude a spec and says "go"
- User approved a spec during `/brainstorm` and the next step is implementation
- User is resuming a paused pipeline after fixing a failed phase by hand

## When NOT to invoke

- User is still in discovery ("help me think through X") — invoke `brainstorming` first
- User wants Claude to run one specific phase only (they'll invoke that skill directly — `migrate`, `review`, `triage`, etc.)
- User is hot-fixing a bug — too heavy, just edit and push

## The pipeline

Each phase writes its output to disk. Claude can stop, the user can edit the artifact, and Claude can resume from that phase without re-running earlier ones.

| Phase | Artifact | What Claude does | When it stops |
|---|---|---|---|
| **Brainstorm** | `docs/specs/YYYY-MM-DD-<topic>-design.md` | Invokes `brainstorming` skill to turn idea into reviewed spec | When spec is committed + user approves |
| **Spec review** | PR comment or inline notes | Invokes `codex-review` skill against the spec file | After one round unless criticals found |
| **Plan** | `docs/plans/YYYY-MM-DD-<topic>.md` | Invokes `writing-plans` to break spec into phases | When plan is committed |
| **Plan review** | Inline notes | Invokes `codex-review` skill against the plan | After one round unless criticals found |
| **Branch** | git worktree at `.claude/worktrees/<slug>` or branch on HEAD | Invokes `using-git-worktrees` or cuts branch directly | When branch exists |
| **Implement** | Git commits on the branch | Invokes `subagent-driven-development`, one subagent per plan phase | When all plan phases have landing commits |
| **Migrate** | SQL deltas applied | Invokes `migrate` skill if DB migrations exist in the branch; skips otherwise | When all environments (dev → QA → prod) are in sync |
| **Validate** | `.claude/validation-report.json` | Runs static rules + tests + typecheck + LLM review via `cadence run` (or legacy `claude-autopilot run`) | When validation passes or after 3 failed retries |
| **PR** | GitHub PR number | Invokes `commit-push-pr` or runs `gh pr create` directly | When PR is open |
| **PR review** | PR comment | Invokes `review-2pass` or `codex-pr-review` against the PR | After one round unless criticals found |
| **Triage** | Bugbot thread replies + follow-up commits | Invokes `bugbot` skill to triage reviewer findings | When all HIGH severity items are resolved or human-dismissed |

## Core rules

1. **Do not pause mid-pipeline.** Once past the Brainstorm gate (which is inherently interactive), execute phases end-to-end. Do not ask "want me to continue?" between phases. Do not show intermediate reports. The user gets one report at the end.
2. **Each phase's artifact is the source of truth for the next.** If the plan file changes between phases, the implementation uses the new plan. Claude does not keep phase outputs in memory — re-read from disk.
3. **Failure in a phase triggers recovery, not pause.**
   - Migration fails → fix the SQL, re-run.
   - Validation fails → read the report, fix the blockers, re-run (max 3 attempts).
   - PR review finds criticals → fix on branch, push, re-review (max 2 rounds).
   - Bugbot finds real bugs → fix, push, re-triage (max 3 rounds).
   - Unrecoverable failure → stop, report what completed, show what remains.
4. **Codex review is part of the loop, not optional.** The pipeline explicitly dispatches to `gpt-5.5` for spec review, plan review, and PR review. This is the multi-model moat — don't skip it.
5. **Skills are swappable.** `review-2pass` and `council` are alternative review phases — a user can configure which runs. The pipeline doesn't hardcode Claude or Codex.

## Phase outputs

Every phase writes to a predictable path. If Claude crashes or the user stops the pipeline, the resume point is "whatever's the newest unfinished artifact."

```
docs/
├── specs/YYYY-MM-DD-<topic>-design.md      # from Brainstorm
├── plans/YYYY-MM-DD-<topic>.md             # from Plan
└── reviews/<PR>-codex.md                   # from PR review (optional)
.claude/
├── validation-report.json                  # from Validate
└── bugbot-state.json                       # from Triage
```

## Recovery

- **Resume mid-pipeline.** User runs `/autopilot` after fixing a failed phase. Claude reads the newest artifacts, skips completed phases, starts from the first incomplete one.
- **Skip a phase.** `/autopilot --skip migrate` — useful when the pipeline auto-detection is wrong (no migrations exist but the skill wants to run).
- **Rewire a phase.** User edits `.claude/skills/autopilot/SKILL.md` to swap `review-2pass` for `council`. Claude picks up the change on next invocation — skill is the config.

## Why this skill exists separately from CLI subcommands

The CLI subcommands (`cadence run`, `cadence migrate`, etc. — or legacy `claude-autopilot run`/`claude-autopilot migrate`) are imperative — each does one thing. This skill is declarative — it describes the pipeline's *loop invariants* (phase order, artifact paths, recovery rules, when to pause). Claude reads this skill to decide *which* CLI subcommand to run *next*. Users who want to run one phase by hand use the CLI; users who want Claude to drive the whole pipeline invoke this skill.

See also:
- `skills/autopilot/SKILL.md` — detailed step-by-step runbook (deprecated alias for this file in v5; retained for back-compat)
- `skills/migrate/SKILL.md` — migrate phase runbook
- `skills/guardrail.md` — review phase alias (legacy; use `review` subcommand directly)
