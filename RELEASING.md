# Releasing Cadence

Cadence uses [Changesets](https://github.com/changesets/changesets) for
version bumps, CHANGELOG generation, git tagging, npm publishing, and
GitHub Release creation. The day-to-day release flow is two steps:

1. Land feature PRs (each carrying a `.changeset/*.md` file).
2. Merge the auto-opened "Version Packages" PR.

That's it. The bot handles tag + publish + GitHub Release.

## Day-to-day: adding a changeset to your PR

After making changes in your feature branch:

```bash
npx changeset
```

This walks you through:

- **Bump type:** `patch` (bug fix), `minor` (new feature, no breaking
  changes), or `major` (breaking change).
- **Summary:** one or two sentences describing the user-visible change.
  This text lands in CHANGELOG.md verbatim, so write it for the
  reader of the release notes (not your future self reviewing the PR).

The CLI writes `.changeset/<funny-codename>.md`. Commit it alongside
your feature change.

If your PR only touches docs, tests, or CI (per the path filter in
`.github/workflows/changeset-check.yml`), no changeset is required —
the gate will skip itself.

## What the bot does

The `Release` workflow (`.github/workflows/release.yml`) runs on every
push to `master`:

- **If there are unmerged `.changeset/*.md` files** — opens or updates
  a PR titled "chore(release): version packages" on the
  `changeset-release/master` branch. That PR:
  - bumps `package.json` to the cumulative target version
  - regenerates `package-lock.json`
  - rewrites the CHANGELOG.md header for the new version
  - deletes the consumed `.changeset/*.md` files

  Review it like any other PR. Merge when ready.

- **If there are NO unmerged changesets** but `package.json` version is
  greater than what's on npm — runs the publish path:
  - `npx changeset publish` → `npm publish --access public`
  - `git tag -a v$VERSION -m "Release v$VERSION"` (matches our v*
    discipline; changesets' default `pkg@version` is overridden)
  - `git push origin v$VERSION`
  - `gh release create v$VERSION` with the new CHANGELOG section as
    body

So merging the Version Packages PR triggers the next master push,
which then triggers the publish. Two clicks per release.

## Emergency manual release

After the changesets migration, a manual `git tag -a vX.Y.Z && git push
origin vX.Y.Z` no longer publishes to npm — the tag-triggered
publish job in `.github/workflows/ci.yml` was deleted. The supported
emergency path is:

1. Bump `package.json` version on master (commit directly or via PR).
2. From a maintainer workstation:
   ```bash
   npm whoami                        # confirm auth
   npm publish --access public       # use --tag next for pre-releases
   ```
3. `git tag -a vX.Y.Z -m "Release vX.Y.Z" && git push origin vX.Y.Z`
   (for the record).
4. `gh release create vX.Y.Z --generate-notes` for the GitHub Release.

This is intentionally inconvenient — the changesets flow is the paved
path.

## One-time setup (for the repo maintainer)

The release workflow uses a GitHub App token instead of the default
`GITHUB_TOKEN`. Reason: PRs and tag pushes authored by `GITHUB_TOKEN`
do NOT trigger downstream workflows (GitHub's anti-recursion
safeguard). The auto-opened Version Packages PR would not get its own
CI run, and tag pushes wouldn't fire any tag-based automation.

### 1. Create a GitHub App on the cadence repo

1. Go to https://github.com/settings/apps/new (or organization
   settings if cadence is in an org).
2. Name: `cadence-bot` (or any name — surfaced as the PR author).
3. Homepage URL: `https://github.com/axledbetter/cadence`.
4. Disable webhooks (uncheck "Active" under Webhook).
5. **Permissions (least-privilege per codex security review):**
   - Repository → Contents: **Read & write** (push tags, push to the
     Version Packages PR branch)
   - Repository → Pull requests: **Read & write** (open/update the
     Version Packages PR)
   - Repository → Metadata: **Read** (auto-granted)
   - Do NOT grant `Workflows: write` unless you specifically want the
     bot to be able to modify `.github/workflows/*.yml` files. Our
     release flow doesn't need it.
6. **Where can this app be installed?** Only on this account.
7. Click "Create GitHub App". Note the **App ID** displayed at the top
   of the next page.
8. Scroll down, click **Generate a private key**. A `.pem` file
   downloads. Keep it safe — you'll paste it into a repo secret.
9. In the app's settings, click **Install App** → install on
   `axledbetter/cadence` only.

### 2. Add two repository secrets

Settings → Secrets and variables → Actions → New repository secret:

- `CADENCE_BOT_APP_ID` — the App ID number from step 7 above.
- `CADENCE_BOT_PRIVATE_KEY` — paste the entire contents of the `.pem`
  file, including the `-----BEGIN RSA PRIVATE KEY-----` and
  `-----END RSA PRIVATE KEY-----` lines.

### 3. npm Trusted Publishing (OIDC) — replaces `NPM_TOKEN`

The release workflow authenticates to npm via [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) — GitHub Actions' OIDC identity is verified directly by npm, no shared secret. You need to configure the trust policy once per package.

#### 3a. Create the `npm-publish` GitHub environment

1. cadence repo → **Settings** → **Environments** → **New environment**.
2. Name: **`npm-publish`** (exact casing — npm's policy matches it literally).
3. Optional: add `Required reviewers` later if you want a human gate on every publish. For now, leave protection rules empty.

#### 3b. Configure the npm trusted-publisher policy

1. npmjs.com → **@delegance/cadence** package page → **Settings** → **Trusted Publishers** → **Add**.
2. Fields:
   - Publisher: **GitHub Actions**
   - Organization or user: **`axledbetter`**
   - Repository: **`cadence`**
   - Workflow filename: **`.github/workflows/release.yml`** (exact path, no leading slash)
   - Environment name: **`npm-publish`** (must match step 3a casing)
3. Save.

#### 3c. First publish

Cut a patch release through the normal changesets flow (or via the emergency manual path). The release workflow will publish via OIDC. Verify two ways:

1. `npm view @delegance/cadence@<new-version> --json | jq '.dist'` — confirms publish succeeded.
2. The package's npmjs.com page now shows a **Provenance** badge linking back to the cadence commit + workflow run.

#### 3d. Decommission `NPM_TOKEN`

After a successful OIDC publish, kill the long-lived token:

1. cadence repo → Settings → Secrets and variables → Actions → delete `NPM_TOKEN` (repo secret, environment secrets, and check org-level secrets too).
2. npmjs.com → your profile → Access Tokens → revoke any granular or classic tokens scoped to `@delegance/*`.

You can now never accidentally rotate the wrong token, leak it in a log, or fail a publish because it expired.

## Troubleshooting

- **Version Packages PR doesn't open.** Check the `Release` workflow
  logs on the latest master push. Most common cause: app token
  permissions missing — re-grant the GitHub App.

- **PR opens but downstream CI doesn't run on it.** App token isn't
  being used by `actions/checkout`. Verify `token: ${{
  steps.app-token.outputs.token }}` is set in the checkout step.

- **`changeset status --since=origin/master` fails with "fatal: bad
  revision".** The PR checkout didn't fetch master. Verify
  `fetch-depth: 0` is set and `git fetch origin master` ran.

- **Publish step fails with `npm error 404 PUT https://registry.npmjs.org/@delegance%2fcadence`.** This is npm's misleading way of saying **auth failed**. With OIDC, this means one of: the trusted-publisher policy isn't configured (or has a typo in owner / repo / workflow filename / environment); the `id-token: write` permission is missing from `release.yml`; the `environment: npm-publish` line is missing from the `release` job; or you haven't bumped the package version (npm returns 404 if you try to re-publish an existing version). Re-walk §3a–3b above against the actual workflow file.

- **`npm too old for trusted publishing`.** The workflow pins npm to `^11.5.0`. If the pinned install itself fails (network blip, registry hiccup), the publish bails fast with a clear message. Re-run the workflow.

- **Tag pushed but no GitHub Release.** The `gh release create` step
  in `release.yml` failed (check logs). Most common cause: `gh` not
  authenticated — the `GITHUB_TOKEN` env var should be the app token.
  Re-run the publish step manually if the tag is good but the release
  is missing.
