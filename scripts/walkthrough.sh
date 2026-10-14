#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Regenerates the walkthrough screenshots (docs/design/walkthroughs/): builds this checkout, starts
# a throwaway stack, runs apps/web/walkthrough against it, and removes the stack. Needs Docker.
# Usage: scripts/walkthrough.sh [playwright args, e.g. a spec file]
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

port="${WALKTHROUGH_PORT:-8099}"
project=fiscus-walkthrough
env_file=$(mktemp)
compose=(docker compose -p "$project" --env-file "$env_file" -f deploy/compose/docker-compose.yml)
cleanup() {
  "${compose[@]}" down -v >/dev/null 2>&1 || true
  rm -f "$env_file"
}
trap cleanup EXIT

cat >"$env_file" <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 16)
APP_DATABASE_PASSWORD=$(openssl rand -hex 16)
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
FISCUS_PORT=$port
FISCUS_PUBLIC_URL=http://localhost:$port
ENV

echo "Starting a fresh stack on port $port..."
"${compose[@]}" down -v >/dev/null 2>&1 || true
"${compose[@]}" up -d --build --wait >/dev/null
token=$("${compose[@]}" logs api | grep -o 'setup token: [A-Za-z0-9_-]*' | tail -1 | cut -d' ' -f3)

# The Playwright image matching @playwright/test, so no local browsers are needed.
version=$(sed -n "s/^ *'@playwright\/test': *//p" pnpm-workspace.yaml)
docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -e E2E_BASE_URL="http://localhost:$port" -e E2E_SETUP_TOKEN="$token" \
  -e WALKTHROUGH_OUT="$PWD/docs/design/walkthroughs/core-ledger" \
  -v "$PWD":"$PWD" -w "$PWD/apps/web" \
  "mcr.microsoft.com/playwright:v$version-noble" \
  npx playwright test -c playwright.walkthrough.config.ts "$@"
