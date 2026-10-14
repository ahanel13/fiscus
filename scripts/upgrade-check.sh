#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Upgrade-path checks against the previous release (docs/design/upgrades.md §8):
#   schema  an install upgraded from the previous release ends with the same schema as a fresh one
#   api     the previous release's api tests pass on this schema, so releases N-1 and N can share
#           a database while an upgrade rolls out (§1.3)
# Usage: scripts/upgrade-check.sh schema|api [release tag, default: the latest before HEAD]
set -euo pipefail

check="${1:?usage: scripts/upgrade-check.sh schema|api [tag]}"
cd "$(git rev-parse --show-toplevel)"

# The newest release tag (vX.Y.Z, no pre-releases) in HEAD's history, other than HEAD itself.
previous="${2:-}"
if [ -z "$previous" ]; then
  head=$(git rev-parse HEAD)
  for tag in $(git tag --merged HEAD --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true); do
    if [ "$(git rev-list -n 1 "$tag")" != "$head" ]; then previous="$tag"; break; fi
  done
fi
if [ -z "$previous" ]; then
  echo "No earlier release to upgrade from: nothing to check."
  exit 0
fi
echo "Upgrading from $previous"

work=$(mktemp -d)
cleanup() {
  git worktree remove --force "$work/previous" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

case "$check" in
  schema)
    git archive "$previous" packages/db/migrations | tar -x -C "$work"
    FISCUS_PREVIOUS_MIGRATIONS="$work/packages/db/migrations" \
      pnpm --filter @fiscus/db exec vitest run src/upgrade.test.ts
    ;;
  api)
    # The previous release's code and tests, on this release's migrations.
    git worktree add --detach "$work/previous" "$previous" >/dev/null
    rm -rf "$work/previous/packages/db/migrations"
    cp -R packages/db/migrations "$work/previous/packages/db/migrations"
    cd "$work/previous"
    pnpm install --frozen-lockfile
    pnpm turbo run build --filter=@fiscus/api^...
    pnpm --filter @fiscus/api test
    ;;
  *)
    echo "Unknown check: $check (schema or api)" >&2
    exit 2
    ;;
esac
