#!/usr/bin/env bash
# Custom publish step invoked by `changesets/action` via the `publish:`
# workflow input. Lives in a real script (not inline workflow YAML) so:
#   - shell semantics are unambiguous (the action passes `publish:` to
#     a single shell invocation; multi-line variable assignment +
#     process substitution + sequential commands are risky inline).
#   - logic is testable / readable / version-controlled normally.
#
# Responsibilities (all idempotent — codex WARNING fixes):
#   1. Run `npx changeset publish --no-git-tag` (npm publish; suppress
#      changesets' default `pkg@version` tag).
#   2. Read the new version from package.json.
#   3. Verify npm actually has $VERSION on the registry (don't tag/
#      release a version that didn't publish — codex WARNING #2).
#   4. If the v$VERSION tag doesn't already exist on origin AND
#      doesn't already exist locally, create and push it. Otherwise
#      skip / push-only as needed (codex WARNING — local-vs-remote tag
#      state can drift on self-hosted runners or manual reruns).
#   5. If the GitHub Release for that tag doesn't already exist,
#      create it with the top CHANGELOG section as body. "Not found"
#      vs auth/transient failures are distinguished explicitly so a
#      partial release doesn't mask the real error (codex WARNING).
#
# Idempotency matters because a partial-failure re-run might find the
# npm publish + tag already in place; we don't want the workflow to
# fail just because the release already exists.

set -euo pipefail

PKG_NAME=$(node -p "require('./package.json').name")

echo "[release] npx changeset publish (no git tag)"
npx changeset publish --no-git-tag

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
echo "[release] target tag: ${TAG}"

# (codex WARNING #2) Verify npm actually has $VERSION before tagging.
# If changesets bailed mid-publish or there was nothing to publish, the
# registry won't reflect $VERSION and we should NOT create a tag.
echo "[release] verifying ${PKG_NAME}@${VERSION} is live on npm"
NPM_VERSION=$(npm view "${PKG_NAME}@${VERSION}" version --registry https://registry.npmjs.org 2>/dev/null || echo "")
if [ "${NPM_VERSION}" != "${VERSION}" ]; then
  echo "[release] FATAL: npm registry does not show ${PKG_NAME}@${VERSION} (got: '${NPM_VERSION}'). Refusing to tag/release."
  exit 1
fi

# (codex WARNING #3) Make tag creation robust to both local and remote
# state. A previous failed attempt might have left a local tag without
# pushing it to origin.
REMOTE_HAS_TAG=$(git ls-remote --tags origin "refs/tags/${TAG}" | grep -c "${TAG}" || true)
LOCAL_HAS_TAG=$(git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null 2>&1 && echo "1" || echo "0")

if [ "${REMOTE_HAS_TAG}" -gt 0 ]; then
  echo "[release] tag ${TAG} already exists on origin — skipping tag push"
else
  if [ "${LOCAL_HAS_TAG}" = "1" ]; then
    echo "[release] local tag ${TAG} exists but remote does not — pushing only"
  else
    echo "[release] creating annotated tag ${TAG}"
    git tag -a "${TAG}" -m "Release ${TAG}"
  fi
  git push origin "refs/tags/${TAG}"
fi

# Release notes — extract the top CHANGELOG.md section (between first
# two `## ` headers).
NOTES_FILE=$(mktemp)
awk '/^## /{c++} c==1{print} c==2{exit}' CHANGELOG.md > "${NOTES_FILE}"

# (codex WARNING #4) GitHub Release — distinguish "not found" (create
# path) from auth/API errors (fail fast). `gh release view` returns
# exit 1 with "release not found" on stderr for missing; any other
# exit / stderr pattern is a real error.
RELEASE_VIEW_STDERR=$(mktemp)
if gh release view "${TAG}" --repo "${GITHUB_REPOSITORY}" >/dev/null 2>"${RELEASE_VIEW_STDERR}"; then
  echo "[release] GitHub Release ${TAG} already exists — skipping"
elif grep -q -i "release not found\|not found" "${RELEASE_VIEW_STDERR}"; then
  echo "[release] creating GitHub Release ${TAG}"
  gh release create "${TAG}" \
    --repo "${GITHUB_REPOSITORY}" \
    --title "${TAG}" \
    --notes-file "${NOTES_FILE}"
else
  echo "[release] FATAL: gh release view failed with non-'not-found' error:"
  cat "${RELEASE_VIEW_STDERR}"
  rm -f "${NOTES_FILE}" "${RELEASE_VIEW_STDERR}"
  exit 1
fi

rm -f "${NOTES_FILE}" "${RELEASE_VIEW_STDERR}"
echo "[release] done."
