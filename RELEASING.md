# Releasing Cadence

This document covers two things:

1. **Cutting a release** — the normal flow (one of two modes, depending on whether the changesets PR has landed).
2. **One-time setup for npm Trusted Publishing** — what the maintainer needs to configure on npmjs.com so the publish workflow can authenticate without `NPM_TOKEN`.

---

## Cutting a release

### Mode A — Changesets-driven (target state, after #232 lands)

1. Every feature PR commits a `.changeset/*.md` declaring its bump type and a one-line summary. (`npx changeset` creates the file interactively.)
2. After merging the feature PR to `master`, the `Release` workflow opens or updates a "Version Packages" PR that bumps `package.json`, rotates the CHANGELOG, and deletes the consumed changeset files.
3. Review and merge the Version Packages PR. The post-merge workflow:
   - Creates a `v$VERSION` git tag.
   - Publishes to npm via OIDC (Trusted Publishing — see below).
   - Creates a GitHub Release using the CHANGELOG entry as the body.

That's it. No manual `git tag`, no manual `package.json` bump, no manual CHANGELOG edit.

### Mode B — Manual (current state until #232 lands, and emergency fallback after)

```bash
# On master, after the feature PRs you want in this release have all merged:
git checkout master && git pull
# Bump package.json version (semver: patch / minor / major as appropriate).
npm version <patch|minor|major> --no-git-tag-version
# Update CHANGELOG.md: change "## Unreleased — vX.Y target" to "## vX.Y.Z — <date>",
# add a new "## Unreleased" header at the top.
# Commit:
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(vX.Y.Z): bump version"
git push
# Wait for CI green on master.
# Tag + push (fires the publish workflow):
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

The publish workflow takes ~5 minutes. Once it completes, `npm view @delegance/cadence dist-tags` shows the new version on `latest` (or `next` for pre-releases).

---

## One-time setup: npm Trusted Publishing (OIDC)

We use [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) instead of long-lived `NPM_TOKEN` secrets. GitHub Actions authenticates to npm directly via the workflow's OIDC identity. Nothing to rotate, nothing to leak.

### Prerequisites

- You're an owner of `@delegance/cadence` on npmjs.com (run `npm access list collaborators @delegance/cadence` to confirm).
- You can administer the cadence GitHub repo (Settings → Environments + Actions).

### Step 1: Create the GitHub environment

1. GitHub → cadence repo → **Settings** → **Environments** → **New environment**.
2. Name: **`npm-publish`** (exact casing — npm's policy matches it literally).
3. Optional: add `Required reviewers` later if you want a human gate on publishes. For now, leave protection rules empty.

### Step 2: Configure the npm trusted-publisher policy

1. npmjs.com → **@delegance/cadence** package page → **Settings** → **Trusted Publishers** → **Add**.
2. Fields:
   - Publisher: **GitHub Actions**
   - Organization or user: **`axledbetter`**
   - Repository: **`cadence`**
   - Workflow filename: **`.github/workflows/ci.yml`** (exact path, no leading slash)
   - Environment name: **`npm-publish`** (must match step 1 casing)
3. Save.

### Step 3: Cut a test release

```bash
# In the cadence repo, bump to v8.5.1 (or any unused patch version):
# ... follow Mode A or Mode B above ...
git tag -a v8.5.1 -m "v8.5.1 — first OIDC publish"
git push origin v8.5.1
```

The publish workflow should succeed. Two ways to verify:

1. `npm view @delegance/cadence@8.5.1 --json | jq '.dist'` — confirms the version landed.
2. The package's npmjs.com page now shows a **Provenance** badge linking back to the cadence commit + workflow run.

### Step 4: Decommission `NPM_TOKEN`

After a successful OIDC publish:

1. GitHub → cadence repo → **Settings** → **Secrets and variables** → **Actions** → delete the **`NPM_TOKEN`** repository secret.
2. Also check **Environment secrets** under each environment and **Organization secrets** at the org level — kill any `NPM_TOKEN` there too.
3. npmjs.com → your profile → **Access Tokens** → revoke any granular or classic tokens scoped to `@delegance/*`.

You can now never accidentally rotate the wrong token, leak it in a log, or fail a publish because it expired.

---

## Other delegance packages

The same setup applies to:

- `@delegance/claude-autopilot` (deprecated tombstone — still receives the redirect publish)
- `@delegance/guardrail`
- `@delegance/sdk`

Each requires its own trusted-publisher policy on npmjs.com, bound to whichever repo + workflow + environment publishes it. Audit which repo currently publishes each one (`gh api /repos/<owner>/<repo>/actions/workflows | jq '.workflows[].path'`) before configuring.

---

## Troubleshooting

### "Cannot find tag matching package.json version"

The `Validate tag matches package version` step compares `vX.Y.Z` to `package.json:version`. If they disagree, the publish fails. Either the tag was pushed against the wrong commit (use `git ls-remote --tags origin` to inspect) or the version bump didn't land before the tag. Fix by re-tagging on the right commit.

### "npm error 404 PUT https://registry.npmjs.org/@delegance%2fcadence — Not found"

npm's misleading way of saying **auth failed**. With OIDC, this means either:

- The trusted-publisher policy isn't configured (or has a typo in owner/repo/workflow/environment).
- The workflow is running on a ref that the policy doesn't allow.
- The `id-token: write` permission is missing.
- The `environment: npm-publish` line is missing from the publish job.

Check the publish job log for the line starting with `npm notice publishing to`. If it says `with auth: ...`, the auth worked; the failure is elsewhere. If it just dies with 404, auth failed.

### "npm too old for trusted publishing"

The workflow pins npm to `^11.5.0`. If the pinned install itself fails (network issue, registry hiccup), the publish bails fast with a clear message. Re-run the workflow.
