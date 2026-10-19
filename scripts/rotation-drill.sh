#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The master key rotation drill (docs/security/encryption.md, #25), against a running compose
# stack: rotate to a new key with both loaded, re-wrap with rotate-key, restart with the new key
# alone, and check that every household's data key still opens, through the app's own code. Then
# check the api refuses to start with the old key alone. CI runs it after the end-to-end tests.
# It leaves the stack on the new key. Usage: scripts/rotation-drill.sh  (COMPOSE as in
# backup-drill.sh; the stack's .env is read for the current key)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

COMPOSE="${COMPOSE:-docker compose -f deploy/compose/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-deploy/compose/.env}"
old=$(sed -n 's/^APP_ENCRYPTION_KEY=//p' "$ENV_FILE")
old_version=$(sed -n 's/^APP_ENCRYPTION_KEY_VERSION=//p' "$ENV_FILE")
old_version=${old_version:-1}
new_version=$((old_version + 1))
new=$(openssl rand -base64 32)
maintenance=$(openssl rand -hex 24)

# Every household's data key, unwrapped with the keys the api is given (as the app does it).
check_keys() {
  $COMPOSE run --rm --no-deps -e MAINTENANCE_DATABASE_PASSWORD="$maintenance" --entrypoint node api \
    --input-type=module -e "
      import { envKeyProvider } from '@fiscus/crypto';
      import { createDb, HouseholdKeyStore, households } from '@fiscus/db';
      const keys = await envKeyProvider({
        APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
        APP_ENCRYPTION_KEY_VERSION: Number(process.env.APP_ENCRYPTION_KEY_VERSION),
        APP_ENCRYPTION_KEY_PREVIOUS: process.env.APP_ENCRYPTION_KEY_PREVIOUS || undefined,
        APP_ENCRYPTION_KEY_PREVIOUS_VERSION: Number(process.env.APP_ENCRYPTION_KEY_PREVIOUS_VERSION) || undefined,
      }).masterKeys();
      const db = createDb('postgres://fiscus_maintenance:' + process.env.MAINTENANCE_DATABASE_PASSWORD + '@db:5432/fiscus');
      const ids = (await db.db.select({ id: households.id }).from(households)).map((h) => h.id);
      const store = new HouseholdKeyStore(db.db, keys);
      for (const id of ids) await store.activeKey(id);
      console.log('opened ' + ids.length + ' household keys with ' + keys);
      await db.close();
    "
}

echo "1. Both keys loaded: the new one (v$new_version) current, the old one previous"
export APP_ENCRYPTION_KEY="$new" APP_ENCRYPTION_KEY_VERSION="$new_version"
export APP_ENCRYPTION_KEY_PREVIOUS="$old" APP_ENCRYPTION_KEY_PREVIOUS_VERSION="$old_version"
export MAINTENANCE_DATABASE_PASSWORD="$maintenance"
$COMPOSE up -d --wait >/dev/null
check_keys

echo "2. Re-wrapped with rotate-key"
$COMPOSE --profile maintenance run --rm rotate-key --check && {
  echo "--check should report the old key still in use" >&2
  exit 1
} || true
$COMPOSE --profile maintenance run --rm rotate-key
$COMPOSE --profile maintenance run --rm rotate-key --check

echo "3. The new key alone opens every household's data key"
unset APP_ENCRYPTION_KEY_PREVIOUS APP_ENCRYPTION_KEY_PREVIOUS_VERSION
$COMPOSE up -d --wait >/dev/null
check_keys

echo "4. Fails closed: the old key alone opens nothing, and the api refuses keys that can't work"
if APP_ENCRYPTION_KEY="$old" APP_ENCRYPTION_KEY_VERSION="$old_version" check_keys >/dev/null 2>&1; then
  echo "The old key still opened the household keys" >&2
  exit 1
fi
out=$(timeout 120 $COMPOSE run --rm --no-deps -e APP_ENCRYPTION_KEY_PREVIOUS="$new" \
  -e APP_ENCRYPTION_KEY_PREVIOUS_VERSION="$new_version" api 2>&1 || true)
echo "$out" | grep -q "Two master keys have version $new_version" || {
  echo "Expected the api to refuse two keys with one version; it said: $out" >&2
  exit 1
}
echo "Rotated to master key v$new_version; the stack now runs on it."
