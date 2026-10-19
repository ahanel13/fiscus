#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The restore drill (docs/security/backups.md, #306), against a running compose stack: take an
# encrypted backup with fiscus-backup, check it can't be read as is, decrypt it with the private
# key, restore it into an empty database, and compare it with the live one, table by table.
# CI runs it after the end-to-end tests, so the database holds their data.
# Usage: scripts/backup-drill.sh   (COMPOSE overrides the compose command)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

COMPOSE="${COMPOSE:-docker compose -f deploy/compose/docker-compose.yml}"
work=$(mktemp -d)
cleanup() {
  $COMPOSE exec -T db dropdb -U fiscus_owner --if-exists fiscus_drill >/dev/null 2>&1 || true
  $COMPOSE run --rm --no-deps --entrypoint rm backup -rf /backups/drill >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

echo "1. A key pair, as an operator makes one (the private key stays off the server)"
$COMPOSE run --rm --no-deps --entrypoint age-keygen backup > "$work/identity.txt" 2>/dev/null
recipient=$(grep -o 'age1[0-9a-z]*' "$work/identity.txt" | head -1)
# Readable by the container's node user; it's a throwaway key.
chmod 644 "$work/identity.txt"

echo "2. One backup, encrypted to it"
$COMPOSE run --rm --no-deps -e BACKUP_AGE_RECIPIENTS="$recipient" -e BACKUP_INTERVAL_HOURS=0 \
  -e BACKUP_DIR=/backups/drill backup
file=$($COMPOSE run --rm --no-deps --entrypoint sh backup -c 'ls /backups/drill/*.dump.age')
file=$(echo "$file" | tr -d '\r' | tail -1)

echo "3. It's age-encrypted: no dump inside without the key"
header=$($COMPOSE run --rm --no-deps --entrypoint sh backup -c "head -c 21 '$file'")
[ "$header" = "age-encryption.org/v1" ] || { echo "Not an age file: $header" >&2; exit 1; }
if $COMPOSE run --rm --no-deps --entrypoint sh backup -c "pg_restore --list '$file'" >/dev/null 2>&1; then
  echo "pg_restore could read the encrypted file" >&2
  exit 1
fi

echo "4. Decrypted with the private key and restored into an empty database"
$COMPOSE exec -T db createdb -U fiscus_owner fiscus_drill
$COMPOSE run --rm --no-deps -v "$work/identity.txt:/run/identity.txt:ro" --entrypoint sh backup -c \
  "age -d -i /run/identity.txt '$file' | pg_restore --exit-on-error --dbname \"\${MIGRATION_DATABASE_URL%/*}/fiscus_drill\""

echo "5. The same rows, table by table, and the same transactions"
psql() { $COMPOSE exec -T db psql -U fiscus_owner -At -v ON_ERROR_STOP=1 "$@"; }
tables=$(psql -d fiscus -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")
counts() {
  for t in $tables; do echo "$t $(psql -d "$1" -c "SELECT count(*) FROM public.\"$t\"")"; done
}
counts fiscus > "$work/live"
counts fiscus_drill > "$work/restored"
diff "$work/live" "$work/restored"
sum="SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY id), '')) FROM transactions t"
[ "$(psql -d fiscus -c "$sum")" = "$(psql -d fiscus_drill -c "$sum")" ] || {
  echo "The restored transactions differ" >&2
  exit 1
}
rows=$(awk '{ n += $2 } END { print n }' "$work/live")
echo "Restored $(wc -l < "$work/live") tables, $rows rows, from $(basename "$file")."
