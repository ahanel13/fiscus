#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Says where two builds of one image differ (#390): the config, then each layer whose digest
# differs, by its file listing (names, modes, owners, sizes, times) and its files' contents. For
# the single-platform OCI archives scripts/build-image.sh --oci writes.
# Usage: compare-images.sh <first.tar> <second.tar>
set -euo pipefail

a="${1:?usage: compare-images.sh <first.tar> <second.tar>}"
b="${2:?usage: compare-images.sh <first.tar> <second.tar>}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

blob() { tar -xOf "$1" "blobs/${2/://}"; }
manifest() { blob "$1" "$(tar -xOf "$1" index.json | jq -r '.manifests[0].digest')"; }
manifest "$a" > "$work/a.manifest"
manifest "$b" > "$work/b.manifest"

ca=$(jq -r .config.digest "$work/a.manifest")
cb=$(jq -r .config.digest "$work/b.manifest")
if [ "$ca" != "$cb" ]; then
  echo "== config differs"
  diff <(blob "$a" "$ca" | jq -S .) <(blob "$b" "$cb" | jq -S .) || true
fi

mapfile -t la < <(jq -r '.layers[].digest' "$work/a.manifest")
mapfile -t lb < <(jq -r '.layers[].digest' "$work/b.manifest")
if [ "${#la[@]}" != "${#lb[@]}" ]; then
  echo "== layer count differs: ${#la[@]} vs ${#lb[@]}; comparing the first ones in order"
  if [ "${#lb[@]}" -lt "${#la[@]}" ]; then la=("${la[@]:0:${#lb[@]}}"); fi
fi
for i in "${!la[@]}"; do
  [ -n "${lb[$i]:-}" ] || break
  [ "${la[$i]}" = "${lb[$i]}" ] && continue
  echo "== layer $i differs: ${la[$i]} vs ${lb[$i]}"
  for side in a b; do
    if [ "$side" = a ]; then archive="$a" layer="${la[$i]}"; else archive="$b" layer="${lb[$i]}"; fi
    mkdir -p "$work/$side$i"
    blob "$archive" "$layer" > "$work/$side$i.tgz"
    echo "   uncompressed ($side): sha256:$(gzip -dc "$work/$side$i.tgz" | sha256sum | cut -d' ' -f1)"
    tar -tvzf "$work/$side$i.tgz" --full-time | sort -k6 > "$work/$side$i.list"
    tar -xzf "$work/$side$i.tgz" -C "$work/$side$i" --no-same-owner 2>/dev/null || true
    (cd "$work/$side$i" && find . -type f -print0 | sort -z | xargs -0r sha256sum) > "$work/$side$i.sums"
  done
  echo "-- listing"
  diff "$work/a$i.list" "$work/b$i.list" || true
  echo "-- contents"
  diff "$work/a$i.sums" "$work/b$i.sums" || true
done
