#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Fails if a migration that exists on the base branch was edited, renamed, or deleted.
# Merged migrations have already run on self-hosters' databases: fix forward with a new one
# (docs/design/upgrades.md §4). drizzle-kit's meta/ files are bookkeeping and may change.
set -euo pipefail

base="${1:-origin/main}"
changed=$(git diff --name-status "$base"...HEAD -- packages/db/migrations ':(exclude)packages/db/migrations/meta' \
  | grep -E '^(M|D|R)' || true)

if [ -n "$changed" ]; then
  echo "Merged migrations must not change (docs/design/upgrades.md §4). Add a new migration instead:"
  echo "$changed"
  exit 1
fi
echo "Migrations: only additions."
