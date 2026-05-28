---
"@delegance/cadence": patch
---

Adopt changesets-driven release automation. Replaces the manual `chore(vX.Y.Z): bump version` PR + `git tag` dance with `@changesets/cli` + `changesets/action`. Day-to-day release flow is now: add a `.changeset/*.md` to each feature PR (`npx changeset`), then merge the auto-opened "Version Packages" PR. The bot handles tag (`v*` format), npm publish, and GitHub Release. See `RELEASING.md` for the GitHub App setup required after this lands.
