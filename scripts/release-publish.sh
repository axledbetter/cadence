#!/usr/bin/env bash
# Custom publish step invoked by `changesets/action` via the `publish:`
# workflow input. Lives in a real script (not inline workflow YAML) so:
#   - shell semantics are unambiguous (the action passes `publish:` to
#     a single shell invocation; multi-line variable assignment +
#     process substitution + sequential commands are risky inline).
#   - logic is testable / readable / version-controlled normally.
#
# Responsibilities (all idempotent, codex WARNING fix):
#   1. Run `npx changeset publish --no-git-tag` (npm publish; suppress
#      changesets' default `pkg@version` tag).
#   2. Read the new version from package.json.
#   3. If the v$VERSION tag doesn't already exist on origin, create
#      and push an annotated tag.
#   4. If the GitHub Release for that tag doesn't already exist,
#      create it with the top CHANGELOG section as body.
#
# Idempotency matters because a partial-failure re-run might find the
# npm publish + tag already in place; we don't want the workflow to
# fail just because the release already exists.

set -euo pipefail

echo "[release] npx changeset publish (no git tag)"
npx changeset publish --no-git-tag

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
echo "[release] target tag: ${TAG}"

# Tag — only create + push if missing on origin.
if git ls-remote --tags origin "refs/tags/${TAG}" | grep -q "${TAG}"; then
  echo "[release] tag ${TAG} already exists on origin — skipping tag push"
else
  echo "[release] creating annotated tag ${TAG}"
  git tag -a "${TAG}" -m "Release ${TAG}"
  git push origin "${TAG}"
fi

# Release notes — extract the top CHANGELOG.md section (between first
# two `## ` headers).
NOTES_FILE=$(mktemp)
awk '/^## /{c++} c==1{print} c==2{exit}' CHANGELOG.md > "${NOTES_FILE}"

# GitHub Release — only create if missing.
if gh release view "${TAG}" --repo "${GITHUB_REPOSITORY}" >/dev/null 2>&1; then
  echo "[release] GitHub Release ${TAG} already exists — skipping"
else
  echo "[release] creating GitHub Release ${TAG}"
  gh release create "${TAG}" \
    --repo "${GITHUB_REPOSITORY}" \
    --title "${TAG}" \
    --notes-file "${NOTES_FILE}"
fi

rm -f "${NOTES_FILE}"
echo "[release] done."
