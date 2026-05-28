---
title: Changesets — automated version bumps + CHANGELOG
date: 2026-05-27
risk_tier: low
status: design
---

# Changesets-Driven Release Automation

## Why

Today's release flow (session 2026-05-27 shipped v8.5.0 this way):
1. Land feature PRs.
2. Manually open a "chore(vX.Y.Z): bump version" PR that edits `package.json`, `package-lock.json`, and `CHANGELOG.md`.
3. Manually re-write CHANGELOG's "Unreleased — vX.Y target" header (which drifts behind reality — at the start of this session the header still said "v8.4.0 target" after v8.4.0 had shipped).
4. Wait for that PR's CI.
5. Merge it.
6. `git checkout master && git pull && git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z` to fire the publish workflow.

Steps 2–6 are four manual operations per release, each of which can drift. CHANGELOG drift is the silent killer — the file is supposed to be the source of truth for what shipped, and the manual flow gives it half-life of about a week.

`@changesets/cli` (used by Astro, Remix, Vite, tRPC, Turborepo, etc.) compresses this into: each feature PR commits a `.changeset/*.md` file declaring its bump type + summary; a bot opens/updates one persistent "Version Packages" PR; merging that PR cuts the version, CHANGELOG entry, git tag, and triggers publish — all from one click.

## Goal

After this PR lands, the manual release flow is:
1. Land feature PRs (each carrying a `.changeset/*.md` file).
2. Merge the auto-opened "Version Packages" PR.

That's it. The tag, CHANGELOG, publish trigger all happen automatically.

## Non-goals

- Changing what dist-tag a version lands on (changesets uses `latest` for stable, `next` for pre-releases — same rule we have today).
- Switching to conventional commits (changesets uses explicit per-PR markdown files; commit message format unchanged).
- Multi-package monorepo workflows (we have one publishable package; the monorepo features stay unused but cost nothing).

## Publish-path ownership (load-bearing — codex CRITICAL fix)

Codex flagged that the original draft had **two competing publish paths**: changesets-action with `publish: npx changeset publish` AND the existing tag-triggered `Publish to npm` job in `ci.yml`. That's a race condition.

**Decision**: changesets owns publish. The existing tag-triggered publish job in `ci.yml` is **deleted** by this PR. Reason: changesets-action's `publish` step already does `npm publish` for every changed package + creates the GitHub Release; running the existing job on top would attempt a duplicate publish that npm rejects (and obscures the actual failure mode).

The existing `ci.yml` job is retained for test/typecheck/bin-smoke — only the `publish:` job is removed.

## Architecture

```
PR author workflow:
  $ npx changeset                  # interactive — picks bump type (patch/minor/major) + summary
  → creates .changeset/<short-name>.md
  → commit alongside the feature change

After merge to master:
  changesets-action GitHub Action fires.
    Has unmerged .changeset/*.md files? → open/update "Version Packages" PR that:
      - bumps package.json version per the cumulative changeset bumps
      - regenerates package-lock.json
      - rewrites the CHANGELOG.md header to the new version
      - deletes the consumed .changeset/*.md files
    No unmerged changesets? → no-op.

Maintainer workflow:
  Review the auto-opened Version PR (it's just a normal PR).
  Merge it. The post-merge action then:
    - tags vX.Y.Z
    - pushes the tag (triggers existing publish job)
    - creates a GitHub Release with the CHANGELOG entry as body
```

## Components

### 1. Install + init

```bash
npm install --save-dev @changesets/cli
npx changeset init
```

Creates:
- `.changeset/config.json` (committed)
- `.changeset/README.md` (committed)

### 2. Install (codex WARNING fix — both packages required)

```bash
npm install --save-dev @changesets/cli @changesets/changelog-github
```

The changelog generator is a runtime dep of `npx changeset version` — installing only `@changesets/cli` would make the version step fail.

### 3. `.changeset/config.json`

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.1.1/schema.json",
  "changelog": [
    "@changesets/changelog-github",
    { "repo": "axledbetter/cadence" }
  ],
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "master",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

### 4. Tag-format adapter (codex CRITICAL fix)

Changesets default tag format is `pkg-name@version` (e.g. `@delegance/cadence@8.6.0`), NOT `v8.6.0`. Our publish discipline downstream (release notes, `git log --tags`, npm provenance checks) is built around `v*` tags.

Override changesets to emit `v*` tags via the `publish` step:

```yaml
- uses: changesets/action@v1
  with:
    version: npx changeset version && npm install --package-lock-only
    publish: |
      npx changeset publish --no-git-tag
      VERSION=$(node -p "require('./package.json').version")
      git tag -a "v$VERSION" -m "Release v$VERSION"
      git push origin "v$VERSION"
    createGithubReleases: true
```

`--no-git-tag` stops changesets from creating the default `pkg@version` tag; we create our `v$VERSION` tag explicitly. The GitHub Release is created off this tag.

### 5. `.github/workflows/release.yml` (new)

```yaml
name: Release
on:
  push:
    branches: [master]
permissions:
  contents: write   # to create the version PR + tag
  pull-requests: write
  id-token: write   # for OIDC publish (lands with trusted-publishing PR)

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v6
        with:
          node-version: '22'
          cache: npm
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - uses: changesets/action@v1
        with:
          # No `publish` arg → action only opens/updates the version PR.
          # When the version PR is merged, the next master push runs the
          # action again; this time there are no pending changesets but
          # the package version > what's on npm, so it tags + publishes.
          publish: npx changeset publish
          version: npx changeset version
          createGithubReleases: true
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # NPM_TOKEN omitted — OIDC via trusted publishing
```

### 6. PR template addition

`.github/pull_request_template.md` (new — or append if exists):

```markdown
## Changeset

Run `npx changeset` to add a release note describing this PR's user-visible
change. PRs without a changeset will fail the changeset-check CI gate
(unless they touch only docs/tests/CI).
```

### 7. Changeset-required CI gate (codex CRITICAL fix — bot exemption)

The auto-opened "Version Packages" PR deletes the consumed `.changeset/*.md` files; if the gate runs on that PR, it'd fail and block the very PR required to merge a release.

Also: `.changeset/config.json`'s `ignore` field only ignores **packages**, not file paths. Path-based docs/CI exemption has to live in the gate workflow itself.

```yaml
name: Changeset check
on:
  pull_request:
    branches: [master]
jobs:
  check:
    runs-on: ubuntu-latest
    # Exempt the auto-generated Version Packages PR.
    if: github.actor != 'github-actions[bot]' && github.head_ref != 'changeset-release/master'
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: tj-actions/changed-files@v45
        id: changed
        with:
          files: |
            !docs/**
            !**/*.md
            !.github/**
            !**/*.test.ts
      - uses: actions/setup-node@v6
        if: steps.changed.outputs.any_changed == 'true'
        with: { node-version: '22', cache: npm }
      - run: npm ci
        if: steps.changed.outputs.any_changed == 'true'
      - run: npx changeset status --since=origin/master
        if: steps.changed.outputs.any_changed == 'true'
```

Two layers of exemption:
1. Bot/release-branch exemption — skip the entire job for changesets-action's PR.
2. Path-filter — docs/test/CI-only PRs don't need a changeset.

### 8. Bot-PR CI triggering (codex WARNING)

PRs opened by the default `GITHUB_TOKEN` don't trigger downstream workflows (GitHub anti-recursion safeguard). The Version Packages PR therefore wouldn't run our test/bin-smoke matrix unless we work around it. Two options:
1. **App token** — use a GitHub App (e.g. a bot account or the `actions/create-github-app-token` action) to author the PR. Workflows run normally. Cost: one-time GitHub App setup.
2. **PAT** — fine-scoped personal access token in `secrets.CHANGESETS_PAT`. Easier but uses a personal credential.

Decision: **App token** for OSS hygiene. Setup is one extra step in the rollout plan.

### 6. Backfill the existing CHANGELOG header

Run `npx changeset version` once locally on a branch to consume any in-flight changesets and rewrite the CHANGELOG header to the next version. This is a one-time fix-up commit; from then on, the action handles it.

## Testing

- Open a no-op PR with a `patch`-bump changeset file. Verify changeset-check passes.
- Merge it. Verify changesets-action opens a "Version Packages" PR with the right bump + CHANGELOG entry.
- Merge the version PR. Verify: tag pushed, GitHub Release created with CHANGELOG body, publish job triggered.

## Backward compatibility

- Old release-flow muscle memory still works — you can still `git tag -a vX.Y.Z && git push origin vX.Y.Z` if you want to bypass the automation (e.g. emergency patch). The publish job is unchanged.
- The `chore(vX.Y.Z): bump version` PR pattern is replaced by the auto-opened "Version Packages" PR but the underlying CI gates (test, bin-smoke, RLS, bugbot) all still run.

## Out of scope

- Cross-package version locking (one publishable package; not relevant).
- Pre-release management (`next` dist-tag for `-pre` versions still works via the publish job's existing regex).

## Post-launch follow-ups

- Run a one-time sweep on all open PRs to ensure they carry changeset files. PRs older than this change get an exemption note.
- Add a `npm run release:preview` script that runs `npx changeset status --output=human` so contributors can sanity-check what their PR's release entry will look like before pushing.
