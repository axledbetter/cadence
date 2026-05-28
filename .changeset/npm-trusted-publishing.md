---
"@delegance/cadence": patch
---

CI: switch the release workflow from `NPM_TOKEN` to npm Trusted Publishing (OIDC).

The `Release` workflow now authenticates to npm via the GitHub Actions OIDC identity — no long-lived shared secret. Requires a one-time trusted-publisher policy on npmjs.com bound to `axledbetter/cadence` + `.github/workflows/release.yml` + `npm-publish` environment. See `RELEASING.md` §3 for the setup walkthrough. `--provenance` attestations now ship with every publish.
