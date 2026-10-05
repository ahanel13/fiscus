#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Every commit in a pull request must carry a Developer Certificate of Origin sign-off
# ("Signed-off-by:" with the author's email; `git commit -s` adds it). ADR 0007, CONTRIBUTING.md.
#
# Usage: scripts/check-dco.sh <base-ref> [head-ref]
set -eu

base="$1"
head="${2:-HEAD}"
failed=0

for sha in $(git rev-list --no-merges "$base..$head"); do
  author=$(git show -s --format='%an <%ae>' "$sha")
  email=$(git show -s --format='%ae' "$sha" | tr '[:upper:]' '[:lower:]')
  case "$email" in
    # Bots (Renovate, Dependabot) can't certify; their changes are reviewed instead.
    *'[bot]@users.noreply.github.com') continue ;;
  esac
  if ! git show -s --format='%(trailers:key=Signed-off-by,valueonly)' "$sha" \
    | tr '[:upper:]' '[:lower:]' | grep -qF "<$email>"; then
    echo "::error::$(git show -s --format='%h %s' "$sha") — no 'Signed-off-by:' for $author"
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  cat >&2 <<'MSG'

Each commit needs a sign-off certifying you have the right to contribute it under the
project's license (https://developercertificate.org/). Add it to existing commits with:

  git rebase --signoff <base-branch> && git push --force-with-lease
MSG
  exit 1
fi
echo "All commits are signed off."
