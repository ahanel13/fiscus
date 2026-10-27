#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Writes the top of a release's notes (docs/design/upgrades.md §7): how to upgrade, the migrations
# since the previous release and whether rolling back needs a restore, and each image's digest
# (what `docker pull` resolves the tag to, and what a rebuild from the tag reproduces).
# GitHub's generated changelog follows it. Usage: release-notes.sh <tag> <owner> <digests dir>
set -euo pipefail

tag="$1"
owner="$2"
digests="$3"
version="${tag#v}"
# A final release compares with the previous final one, so its notes cover its pre-releases too; a
# pre-release compares with the latest release of either kind (#391).
case "$version" in
  *-*) finals_only=() ;;
  *) finals_only=(--exclude 'v*-*') ;;
esac
previous=$(git describe --tags --abbrev=0 --match 'v[0-9]*' "${finals_only[@]}" "${tag}^" 2>/dev/null || true)

if [ -n "$previous" ]; then
  range="$previous..$tag"
  migrations=$(git diff --name-only --diff-filter=A "$range" -- 'packages/db/migrations/*.sql')
else
  migrations=$(git ls-tree -r --name-only "$tag" -- packages/db/migrations | grep '\.sql$' || true)
fi
# Contract changes (upgrades.md §3) drop or narrow something the previous release may still use.
# A hand-written one the pattern can't see (a narrowed function or policy) says so: `-- Contract:`.
contracts=""
for f in $migrations; do
  if git show "$tag:$f" | grep -qiE 'DROP (TABLE|COLUMN|TYPE)|ALTER TABLE .* DROP COLUMN|SET NOT NULL|^-- Contract:'; then
    contracts+="$f"$'\n'
  fi
done

echo "## Upgrading"
echo
echo "Set \`FISCUS_VERSION=$version\` (or keep \`latest\`), then \`docker compose pull && docker compose up -d\`."
if [ -n "$migrations" ]; then
  echo "This release has database migrations: the \`migrate\` job backs up the database before applying them"
  echo "([upgrades §5](https://github.com/${GITHUB_REPOSITORY:-$owner/fiscus}/blob/$tag/docs/design/upgrades.md#5-backups-before-upgrading))."
fi
echo
if [ -n "$previous" ]; then echo "### Migrations since $previous"; else echo "### Migrations"; fi
echo
if [ -z "$migrations" ]; then
  echo "None. Rolling back is redeploying the previous tag."
else
  for f in $migrations; do echo "- \`$(basename "$f" .sql)\`"; done
  echo
  if [ -z "$previous" ]; then
    echo "The first release: there's nothing earlier to roll back to."
  elif [ -n "$contracts" ]; then
    echo "**These contract the schema**, so rolling back means restoring the pre-upgrade backup (upgrades §6):"
    for f in $contracts; do echo "- \`$(basename "$f" .sql)\`"; done
  else
    echo "All additive: rolling back is redeploying the previous tag; no restore needed."
  fi
fi
echo
echo "## Images"
echo
echo "Multi-arch (amd64, arm64). Each one is reproducible from this tag, signed with cosign, and has"
echo "an SBOM per platform, attested to the image and attached below. To check that what you run is"
echo "exactly this release, see [verifying a release](https://github.com/${GITHUB_REPOSITORY:-$owner/fiscus}/blob/$tag/docs/security/verify-releases.md)."
echo
echo "| Service | Image | Digest |"
echo "|---|---|---|"
for app in api worker web mcp; do
  digest=$(cat "$digests/$app" 2>/dev/null || echo "missing")
  echo "| $app | \`ghcr.io/$owner/fiscus-$app:$version\` | \`$digest\` |"
done
