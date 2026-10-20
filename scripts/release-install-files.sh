#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Writes the install files attached to each release, which the README downloads from the latest
# one (releases/latest/download/...): docker-compose.yml as is, and .env.example with
# FISCUS_VERSION set to the release, so an install stays on it until you choose to upgrade. The
# latter is named env.example: GitHub renames assets whose names start with a dot.
# Usage: release-install-files.sh <tag> <output dir>
set -euo pipefail

tag="$1"
out="$2"
version="${tag#v}"
cd "$(git rev-parse --show-toplevel)"

mkdir -p "$out"
git show "$tag:deploy/compose/docker-compose.yml" > "$out/docker-compose.yml"
git show "$tag:deploy/compose/.env.example" |
  sed "s/^FISCUS_VERSION=.*/FISCUS_VERSION=$version/" > "$out/env.example"
if ! grep -qx "FISCUS_VERSION=$version" "$out/env.example"; then
  echo ".env.example has no FISCUS_VERSION line to pin" >&2
  exit 1
fi
