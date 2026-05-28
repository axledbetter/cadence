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
- **App token is minted BEFORE checkout, and used everywhere** (codex
  CRITICAL fix). Without this, `actions/checkout` persists the default
  `GITHUB_TOKEN` as the credential helper, and `git push origin
  "v$VERSION"` would push with that token — meaning the tag push is
  bot-author = `github-actions[bot]` and does NOT trigger downstream
  workflows on the tag. Shape:
  ```yaml
  steps:
    - uses: actions/create-github-app-token@v1
      id: app-token
      with:
        app-id: ${{ secrets.CADENCE_BOT_APP_ID }}
        private-key: ${{ secrets.CADENCE_BOT_PRIVATE_KEY }}
    - uses: actions/checkout@v6
      with:
        fetch-depth: 0
        token: ${{ steps.app-token.outputs.token }}   # persisted credential helper
    - uses: actions/setup-node@v6
      with: { node-version: '22', cache: npm, registry-url: 'https://registry.npmjs.org' }
    - run: npm ci
    - name: Configure git identity for tagging
      run: |
        git config user.name "cadence-bot[bot]"
        git config user.email "${{ secrets.CADENCE_BOT_APP_ID }}+cadence-bot[bot]@users.noreply.github.com"
    - uses: changesets/action@v1
      with:
        version: npx changeset version && npm install --package-lock-only --ignore-scripts
        publish: |
          npx changeset publish --no-git-tag
          VERSION=$(node -p "require('./package.json').version")
          git tag -a "v$VERSION" -m "Release v$VERSION"
          git push origin "v$VERSION"
          gh release create "v$VERSION" --title "v$VERSION" --notes-file <(awk '/^## /{c++} c==1{print} c==2{exit}' CHANGELOG.md)
        createGithubReleases: false   # we create it ourselves above (codex WARNING fix)
      env:
        GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}   # changesets-action AND gh CLI auth
        NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}            # see "publish auth" below
  ```
- `version: npx changeset version && npm install --package-lock-only --ignore-scripts` —
  regenerates the lockfile so the auto-PR carries a matching
  `package-lock.json`. `--ignore-scripts` prevents lifecycle scripts
  from running during lockfile regen (codex NOTE fix).
- **Publish auth (codex CRITICAL fix):** Track 1 (npm trusted
  publishing via OIDC) is in flight in parallel. Until it merges,
  `NODE_AUTH_TOKEN: secrets.NPM_TOKEN` is wired so the first publish
  doesn't half-succeed (tag pushed but no npm publish). Once track 1
  lands, we remove `NODE_AUTH_TOKEN` and rely on OIDC. We will check
  track 1's status during implementation and, if it's already merged,
  drop the NPM_TOKEN fallback.
- **GitHub Release creation (codex WARNING fix):** `changesets/action`'s
  `createGithubReleases` is wired to its native `pkg@version` tag
  format. Since we're using `--no-git-tag` + explicit `v$VERSION`, we
  set `createGithubReleases: false` and run `gh release create`
  ourselves in the publish script. The awk extracts the top
  CHANGELOG.md section (between the first two `## ` headers) as
  release body.

### 4. `.github/workflows/changeset-check.yml` (new)

Per spec section 7, with the two-layer exemption AND codex CRITICAL
fixes for checkout depth + install + positive-pattern path filter:

- **Bot exemption:**
  `if: github.actor != 'github-actions[bot]' && github.head_ref != 'changeset-release/master'`
  — skips entire job for the auto-generated Version Packages PR (which
  deletes consumed changeset files, so the gate would falsely fail it).
- **Checkout with `fetch-depth: 0` AND explicit `git fetch origin master`**
  so `npx changeset status --since=origin/master` can resolve the
  base ref (codex CRITICAL — PR checkouts don't have origin/master by
  default).
- **`npm ci` before `npx changeset status`** — uses the
  locally-installed `@changesets/cli` (deterministic version) rather
  than letting `npx` download whatever's latest (codex CRITICAL).
- **Path filter** via `tj-actions/changed-files@v45` — uses
  POSITIVE includes + explicit ignores rather than negative-only
  patterns (codex WARNING — negative-only globs have ambiguous
  semantics in this action):
  ```yaml
  files: |
    src/**
    bin/**
    scripts/**
    presets/**
    apps/**
    packages/**
    package.json
    package-lock.json
    tsconfig*.json
  files_ignore: |
    **/*.md
    **/*.test.ts
    docs/**
  ```
- `npx changeset status --since=origin/master` is the actual check —
  fails if no `.changeset/*.md` files present in the diff. Skipped if
  `steps.changed.outputs.any_changed == 'false'`.

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

Actually simpler: this PR ships WITHOUT a changeset because the
`changeset-check.yml` workflow is NOT yet active on `master` (it's
introduced by this PR). Self-consistency from day one is satisfied by
the fact that the gate cannot enforce against the PR that creates the
gate (codex WARNING fix — the original "only touches .github/**"
exemption claim was wrong since this PR also modifies package.json /
package-lock.json which the path filter does NOT exempt).

The NEXT PR that ships a user-visible change adds the first
changeset. The CHANGELOG header for v8.6.0 will then be written by
changesets-action. Existing v8.5.0 and earlier entries are untouched
(changesets only appends — it doesn't rewrite history).

### 8. `RELEASING.md` (new)

New doc covering:

- **How to add a changeset:** `npx changeset` walks you through bump
  type + summary; commit the `.changeset/<name>.md` alongside your
  feature change.
- **What the bot does:** opens/updates a "Version Packages" PR after
  master push; merging it triggers tag + publish + GitHub Release.
- **Emergency manual release (corrected per codex WARNING):** After
  this PR lands, `git tag -a vX.Y.Z && git push origin vX.Y.Z` ONLY
  creates the git tag — it does NOT trigger npm publish (we deleted
  the tag-triggered publish job). The supported emergency path is:
  1. Bump `package.json` version manually on master.
  2. From a maintainer workstation: `npm publish --access public`
     (after `npm whoami` confirms auth).
  3. `git tag -a vX.Y.Z && git push origin vX.Y.Z` for the record.
  4. `gh release create vX.Y.Z` for the GitHub Release.
  This is intentionally inconvenient — the changesets flow is the
  paved path; emergency manual release is meant to be a last resort.
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
