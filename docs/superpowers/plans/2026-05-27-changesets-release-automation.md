---
title: Plan — Changesets-driven release automation
date: 2026-05-27
risk_tier: low
status: plan
spec: docs/superpowers/specs/2026-05-27-changesets-release-automation-design.md
---

# Plan: Changesets Release Automation

Replace the manual "bump version → tag → push tag" dance with
`@changesets/cli` + `changesets/action`. Codex-validated spec; CRITICAL
fixes are load-bearing (publish-path ownership, v* tag adapter, bot-PR
exemption, app-token for downstream CI, both packages installed).

## Worktree

`feature/changesets-release-automation` on the cadence repo at
`/Users/alexledbetter/work/claude-autopilot/.claude/worktrees/changesets`.

## File-level changes

### 1. Dependencies (`package.json`, `package-lock.json`)

`npm install --save-dev @changesets/cli @changesets/changelog-github`

Both required: `@changesets/changelog-github` is the runtime backend the
`version` step uses to format CHANGELOG entries. Installing only the
CLI makes `npx changeset version` fail.

### 2. `.changeset/` directory

`npx changeset init` creates:

- `.changeset/config.json`
- `.changeset/README.md`

Then edit `.changeset/config.json` to use the github changelog backend
and `axledbetter/cadence` repo (full content from spec section 3).

### 3. `.github/workflows/release.yml` (new)

Per spec section 5, with these load-bearing details:

- Triggers on `push` to `master`.
- `permissions: contents: write, pull-requests: write, id-token: write`.
- Uses `changesets/action@v1`.
- `version: npx changeset version && npm install --package-lock-only` —
  the `npm install --package-lock-only` step regenerates the lockfile so
  the auto-PR carries a matching `package-lock.json`. Without this, the
  version-bump PR would have a stale lock and fail `npm ci` in CI.
- `publish:` script overrides default tag format:
  ```bash
  npx changeset publish --no-git-tag
  VERSION=$(node -p "require('./package.json').version")
  git tag -a "v$VERSION" -m "Release v$VERSION"
  git push origin "v$VERSION"
  ```
- `createGithubReleases: true` — auto-creates GitHub Release with
  CHANGELOG body off the `v$VERSION` tag.
- Auth: uses an **app token** from `secrets.CADENCE_BOT_APP_ID` +
  `secrets.CADENCE_BOT_PRIVATE_KEY` via
  `actions/create-github-app-token@v1`. PRs opened with default
  `GITHUB_TOKEN` don't trigger downstream workflows (GitHub
  anti-recursion); app-token PRs do.
- No `NPM_TOKEN` env var here — trusted publishing (track 1, parallel)
  will land OIDC via `id-token: write`. Until that ships, the publish
  step will fail; if track 1 hasn't merged when this lands, we add a
  temporary `NODE_AUTH_TOKEN: secrets.NPM_TOKEN` fallback line. We'll
  check track 1's status before finalizing.

### 4. `.github/workflows/changeset-check.yml` (new)

Per spec section 7, with the two-layer exemption:

- **Bot exemption:**
  `if: github.actor != 'github-actions[bot]' && github.head_ref != 'changeset-release/master'`
  — skips entire job for the auto-generated Version Packages PR (which
  deletes consumed changeset files, so the gate would falsely fail it).
- **Path filter** via `tj-actions/changed-files@v45`:
  ```yaml
  files: |
    !docs/**
    !**/*.md
    !.github/**
    !**/*.test.ts
  ```
  Docs/test/CI-only PRs don't need a changeset.
- `npx changeset status --since=origin/master` is the actual check —
  fails if no `.changeset/*.md` files present in the diff.

### 5. `.github/pull_request_template.md` (new)

Add the Changeset section per spec section 6:

```markdown
## Changeset

Run `npx changeset` to add a release note describing this PR's
user-visible change. PRs without a changeset will fail the
changeset-check CI gate (unless they touch only docs/tests/CI).
```

### 6. Delete the `publish:` job from `.github/workflows/ci.yml`

Lines 68–113 (the entire `publish:` job). Keep everything else:
- `on:` triggers stay as-is (master/tags/PR/workflow_dispatch).
- `test:` job stays (typecheck + supabase audit + tests).
- `workflow_dispatch` stays — useful for re-running test against an
  existing tag.

Reason: changesets owns publish now (spec's "Publish-path ownership"
section). Two publish paths = race condition + duplicate publish
errors.

### 7. One-time backfill: rewrite CHANGELOG header

The CHANGELOG currently has `## v8.5.0 — 2026-05-27` at the top
(shipped today). No in-flight `.changeset/*.md` files exist (we haven't
adopted the workflow yet). So `npx changeset version` on this branch
should be a no-op for content — but we still need to verify the format
of the CHANGELOG header matches what `@changesets/changelog-github`
will produce going forward, otherwise the next release would create a
formatting discontinuity.

Action: run `npx changeset version --snapshot=test` locally on the
worktree to preview output. If it would rewrite the header, add a
"sentinel" first-PR changeset documenting the changesets adoption
itself.

Actually simpler: this PR ships WITHOUT a changeset (changeset-check
exempts it because it touches only `.github/**` + new files in
`.changeset/`). The NEXT PR that ships a user-visible change adds the
first changeset. The CHANGELOG header for v8.6.0 will then be written
by changesets-action. Existing v8.5.0 and earlier entries are
untouched (changesets only appends — it doesn't rewrite history).

### 8. `RELEASING.md` (new)

New doc covering:

- **How to add a changeset:** `npx changeset` walks you through bump
  type + summary; commit the `.changeset/<name>.md` alongside your
  feature change.
- **What the bot does:** opens/updates a "Version Packages" PR after
  master push; merging it triggers tag + publish + GitHub Release.
- **Emergency manual release:** still works — `git tag -a vX.Y.Z && git
  push origin vX.Y.Z` bypasses the bot.
- **One-time setup for the user:**
  1. Create a GitHub App on `axledbetter/cadence`:
     - Repo permissions: Contents (write), Pull requests (write),
       Workflows (write), Metadata (read).
     - Generate a private key, install on the cadence repo only.
  2. Add two repo secrets:
     - `CADENCE_BOT_APP_ID` — the App ID number.
     - `CADENCE_BOT_PRIVATE_KEY` — the entire PEM (including
       `-----BEGIN/END-----` lines).
  3. (Optional) Add `NPM_TOKEN` if trusted publishing hasn't landed
     yet.

## Validation

- `cd .claude/worktrees/changesets && npm run build && npm test` —
  must stay green. The build/test surface doesn't change; only CI
  workflows + dev-deps.
- Manual: confirm `npx changeset --help` works (CLI installed
  correctly).
- Manual: confirm `.changeset/config.json` parses with
  `node -e "JSON.parse(require('fs').readFileSync('.changeset/config.json','utf8'))"`.
- No new tests required — CI changes are exercised when future PRs run
  through the new gates. The first real PR with a changeset will be
  the validation.

## Risk

Low. The change is additive (new workflows + .changeset/ dir + new
dev-deps) plus one deletion (publish job in ci.yml). The deletion is
load-bearing for correctness but easy to revert. If the new
`release.yml` workflow misbehaves on first run, we can disable it via
GitHub UI and fall back to the old manual flow — the publish-via-tag
path still works because the `on: push tags: ['v*']` trigger in
`ci.yml` stays (we only removed the `publish:` job; the master/tag
trigger stays for future use).

Wait — if we remove the publish job AND the trusted-publishing PR
(track 1) hasn't landed, then a manual `git push origin vX.Y.Z`
becomes a no-op (CI fires but nothing publishes). Acceptable: the
changesets path is the primary publish surface, and the emergency
escape is `npm publish` from the maintainer's workstation. Document
this in RELEASING.md.

## Parallel track coordination

- **Track 1 (trusted publishing):** Touches `.github/workflows/ci.yml`
  to add OIDC. We're deleting the publish job; track 1 needs to
  re-target its changes to `release.yml`. If track 1 merges first,
  we rebase and migrate their OIDC changes into our `release.yml`. If
  we merge first, track 1 adapts. Either way, the spec already
  anticipates OIDC by including `id-token: write` in `release.yml`.
- **Track 3 (protocol versioning) / Track 4 (schema-change manifests):**
  No file overlap. Safe to run in parallel.

## Out of scope

- Backfilling changesets for already-shipped versions.
- Migrating CHANGELOG content style retroactively.
- npm provenance attestation (lands with track 1).
