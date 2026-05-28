---
title: npm Trusted Publishing (OIDC) — replace NPM_TOKEN
date: 2026-05-27
risk_tier: medium
status: design
---

# npm Trusted Publishing (OIDC)

## Why

The session 2026-05-26/27 included **four** NPM_TOKEN rotations across `@delegance/cadence`, `claude-autopilot`, `guardrail`, and `sdk` packages, plus a v8.5.0 publish that failed at 20:25 UTC with `npm error 404 PUT https://registry.npmjs.org/@delegance%2fcadence — Not found` (which is npm's misleading way of saying "auth failed"). Long-lived `NPM_TOKEN` secrets in GitHub Actions are the single largest source of release friction in this repo. They also have to be re-rotated whenever the CI workflow itself changes (per memory: `gh rerun` reads stale secret state from the original run, so PR #215 had to add `workflow_dispatch: {}` to enable fresh-event re-trigger).

npm enabled **Trusted Publishing** via OIDC in late 2025. GitHub Actions authenticates to npm directly using its workflow OIDC identity — no shared secret, no rotation, no exfiltration risk.

## Goal

Delete `NPM_TOKEN` from `axledbetter/cadence` and the other four delegance npm packages. Replace with OIDC trust policies configured on npmjs.com per-package.

## Non-goals

- Migrating away from the existing `ci.yml` publish job topology (just swap the auth mechanism).
- Changing what gets published or how dist-tags are computed (semver-driven `latest`/`next` logic stays).
- Multi-registry support (we publish to npmjs only).

## Architecture

```
Today:
  GitHub Actions → reads NPM_TOKEN from secrets → npm publish with NODE_AUTH_TOKEN

Tomorrow:
  GitHub Actions → requests OIDC token from GitHub → npm registry verifies
    (publisher: axledbetter/cadence, workflow: .github/workflows/ci.yml,
     environment: production, ref: refs/tags/v*) → npm publish
```

## Components

### 1. npmjs.com trust policy per package

For each of: `@delegance/cadence`, `@delegance/claude-autopilot` (deprecated but still receives the redirect tombstone), `@delegance/guardrail`, `@delegance/sdk`.

UI path: npmjs.com → package → Settings → Trusted Publishers → Add. Fields:
- Publisher: GitHub Actions
- Organization or user: `axledbetter`
- Repository: `cadence` (or `claude-autopilot` etc.)
- Workflow filename: `.github/workflows/ci.yml`
- Environment name: `npm-publish` (new — see below; gates the publish behind a GitHub environment that can carry additional protection rules like required-reviewers if we want)

### 2. `.github/workflows/ci.yml` publish job rewrite

Remove `NODE_AUTH_TOKEN` env var. Add `permissions.id-token: write`. Use the npm CLI's OIDC mode (`npm publish` ≥ 11.5 detects OIDC automatically when running inside a workflow with the right trust policy in place).

```yaml
publish:
  name: Publish to npm
  needs: test
  runs-on: ubuntu-latest
  if: startsWith(github.ref, 'refs/tags/v')
  environment: npm-publish
  permissions:
    contents: read
    id-token: write   # required for OIDC
  steps:
    - uses: actions/checkout@v6
    - uses: actions/setup-node@v6
      with:
        node-version: '22'
        cache: npm
        registry-url: 'https://registry.npmjs.org'
    - run: npm ci
    - name: Validate tag matches package version
      run: |
        TAG_VERSION="${{ github.ref_name }}"
        TAG_VERSION="${TAG_VERSION#v}"
        PKG_VERSION=$(node -p "require('./package.json').version")
        [ "$TAG_VERSION" = "$PKG_VERSION" ] || { echo "tag/version mismatch"; exit 1; }
    - name: Publish (OIDC)
      env:
        REF_NAME: ${{ github.ref_name }}
      run: |
        if [[ "$REF_NAME" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then TAG="latest"; else TAG="next"; fi
        # OIDC auth — no NODE_AUTH_TOKEN. npm CLI detects the workflow context
        # and exchanges the GitHub OIDC token for an npm publish token
        # automatically. Requires the trust policy on npmjs.com.
        npm publish --access public --tag "$TAG" --provenance
```

`--provenance` is a free side-benefit: npm records a verifiable build attestation linking the package to the source commit + workflow run. Shows up as a "Provenance" badge on the package page.

### 3. GitHub `npm-publish` environment

Settings → Environments → New environment: `npm-publish`. Initially no protection rules (so it doesn't block solo-dev velocity), but the field exists so we can add `Required reviewers` later if the ecosystem grows.

### 4. Decommission `NPM_TOKEN`

After a successful OIDC publish:
- Repo → Settings → Secrets and variables → Actions → delete `NPM_TOKEN`.
- npmjs.com → tokens → revoke any still-valid granular tokens scoped to `@delegance/*`.

## Testing

- **Real publish via v8.5.1 tag** (not a "dry-run" — there is no meaningful dry-run for OIDC since `npm publish --dry-run` doesn't exercise the auth path). If the OIDC handshake works, the publish succeeds. If it doesn't, the tag job fails and v8.5.1 doesn't ship — manual re-tag as v8.5.2 after fix.
- **Machine-readable provenance check**: bin-smoke matrix gets a new step that runs `npm view @delegance/cadence@$VER --json | jq -e '.dist["npm-signature"]'` (or the analogous provenance field — verify the exact key name when implementing) and fails if absent. This replaces the brittle "check the badge" manual step.
- Smoke: `npm view @delegance/cadence@8.5.1 dist-tags` shows the new version on `latest`.

## Backward compatibility

- The old `NPM_TOKEN`-based publish keeps working until the secret is deleted. There is no "during the transition the package can't be published" window.
- Consumers of `@delegance/cadence` see no change. The package, its API, its tarball contents are unchanged.

## Rollout

(Codex CRITICAL — there is **no silent fallback to `NODE_AUTH_TOKEN`** once the workflow stops setting it. The trust policy MUST be in place before the workflow change merges.)

1. **Configure first.** Create the `npm-publish` GitHub environment in the cadence repo. On npmjs.com, configure the trusted-publisher policy for `@delegance/cadence` with the exact owner/repo/workflow-filename/environment values from the table in Components §1.
2. **Cut a no-publish PR** containing this workflow change. Verify CI green; the publish job only fires on tag push, so master CI alone proves nothing breaks.
3. **Cut v8.5.1 tag.** The publish job runs with OIDC. Verify provenance badge appears on npmjs.com.
4. If step 3 fails: revert the workflow change (one-line revert restores `NODE_AUTH_TOKEN` + `secrets.NPM_TOKEN`); investigate; retry.
5. Repeat trust-policy config + workflow change for the other 3 delegance packages.
6. **Only then** delete `NPM_TOKEN` (repo secret, environment secret, org secret — full sweep per Decommission section).

### Per-package configuration table

| npm package | GitHub repo | Workflow file | GH environment | Token to revoke after |
|---|---|---|---|---|
| `@delegance/cadence` | `axledbetter/cadence` | `.github/workflows/ci.yml` | `npm-publish` | `NPM_TOKEN` in cadence repo |
| `@delegance/claude-autopilot` (deprecated tombstone) | `axledbetter/claude-autopilot` (or wherever the tombstone publish workflow lives — verify before configuring) | tombstone workflow file | `npm-publish` | `NPM_TOKEN` in that repo |
| `@delegance/guardrail` | TBD — confirm which repo currently publishes this | TBD | `npm-publish` | `NPM_TOKEN` in that repo |
| `@delegance/sdk` | TBD — same | TBD | `npm-publish` | `NPM_TOKEN` in that repo |

The TBD entries are NOT a placeholder — they're a deliberate gate: before configuring trust policies for those packages, the implementer must verify the actual publish location (codex WARNING — package-to-repo mapping is the easiest thing to misconfigure).

### npm CLI version requirement

Trusted Publishing requires npm CLI ≥ 11.5. The Node 22 image's bundled npm may be older. Pin explicitly:

```yaml
- name: Pin npm to a trusted-publishing-capable version
  run: |
    npm install -g npm@^11.5.0
    npm --version
```

Fail-loud step before publish: `node -e "if (process.versions.npm.split('.').map(Number)[0] < 11) { console.error('npm too old'); process.exit(1); }"`.

## Out of scope

- Trusted publishing for the dashboard's Vercel/Fly deploys (separate workflow, separate secrets — different PR if desired).
- Migration to npm Workspaces' built-in `npm publish --workspaces` flow (orthogonal).

## Post-launch follow-ups

- Add `--provenance` validation to the bin-smoke matrix so the badge can't silently regress.
- Document the OIDC trust policy in the cadence repo's `RELEASING.md` (file doesn't exist yet; this PR creates it).
