#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Builds one service's image the way releases are built, so the same commit gives the same image
# digest wherever it's built (ADR 0014 §4, docs/security/verify-releases.md): CI, the release
# workflow, and anyone checking a release all run this.
#
# Usage: build-image.sh <app> [--platform <list>] (--oci <file> | --push <repository>) [buildx options]
#   --oci <file>         write an OCI archive (nothing is pushed)
#   --push <repository>  push by digest only, untagged; the release tags it once it's verified
# Prints the image's digest. Needs a buildx builder using the docker-container driver
# (docker buildx create --use).
set -euo pipefail

app="${1:?usage: build-image.sh <app> [--platform <list>] (--oci <file> | --push <repository>)}"
shift
platform="linux/amd64,linux/arm64"
output=""
extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) platform="$2"; shift 2 ;;
    --oci) output="type=oci,dest=$2"; shift 2 ;;
    --push) output="type=image,name=$2,push-by-digest=true,name-canonical=true,push=true"; shift 2 ;;
    *) extra+=("$1"); shift ;;
  esac
done
[ -n "$output" ] || { echo "build-image.sh: --oci or --push is required" >&2; exit 2; }

root=$(git rev-parse --show-toplevel)
cd "$root"
if [ -n "$(git status --porcelain)" ]; then
  echo "build-image.sh: warning: the working tree has changes, so this won't match a release" >&2
fi

# Everything that ends up in the image comes from the commit, not from when or where it's built:
# file times are clamped to the commit's time, and the labels name only the commit.
revision=$(git rev-parse HEAD)
export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct HEAD)
created=$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -r "$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ)
version=$(git describe --tags --exact-match --match 'v[0-9]*' HEAD 2>/dev/null || true)
labels=(
  --label "org.opencontainers.image.title=fiscus-$app"
  --label "org.opencontainers.image.licenses=AGPL-3.0-or-later"
  --label "org.opencontainers.image.source=https://github.com/ahanel13/fiscus"
  --label "org.opencontainers.image.revision=$revision"
  --label "org.opencontainers.image.created=$created"
)
if [ -n "$version" ]; then labels+=(--label "org.opencontainers.image.version=${version#v}"); fi

metadata=$(mktemp)
trap 'rm -f "$metadata"' EXIT
# Provenance and SBOM attestations stay out of the image index: they record when the build ran,
# which would change its digest. The release signs and attests the image with cosign instead.
docker buildx build \
  --file "apps/$app/Dockerfile" \
  --platform "$platform" \
  --build-arg SOURCE_DATE_EPOCH \
  --provenance=false --sbom=false \
  "${labels[@]}" \
  --output "$output,rewrite-timestamp=true" \
  --metadata-file "$metadata" \
  "${extra[@]}" \
  . >&2
jq -r '."containerimage.digest"' "$metadata"
