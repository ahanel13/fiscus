# Encryption at rest

How Fiscus encrypts sensitive fields, and what operators must do to keep data recoverable.
Design: [ADR 0005](../adr/0005-tenancy-and-trust-model.md). Code: `packages/crypto`,
`packages/db/src/household-key-store.ts`.

## Keys

```
APP_ENCRYPTION_KEY (master key, 32 bytes, env or _FILE)
  │  HKDF-SHA256
  ├─ "fiscus/household-key-wrap/v1" → wraps each household's data key
  └─ "fiscus/instance-secrets/v1"   → encrypts per-user secrets (e.g. TOTP seeds)

household_keys (one row per household per version)
  wrapped_key = AES-256-GCM(wrap key, household data key, AAD = household id + version)
```

- The **master key** never encrypts data directly. Purpose-specific subkeys are derived from it.
- Each **household** has its own random 256-bit data key, stored only in wrapped form.
- Unwrapped data keys stay in memory for at most 5 minutes, are wiped on eviction, and refuse to
  be printed or serialized (`SecretKey` redacts itself in logs, JSON, and `inspect`).

## Ciphertext format

```
[1 byte format=0x01][4 bytes key version][12 bytes random IV][ciphertext][16 bytes GCM tag]
```

- **Associated data** binds every value to where it lives:
  `fiscus:v1:h:<household>:<table>:<column>:<row id>` (or `…:i:…` for instance secrets).
  A value copied to another row, column, table, or household fails to decrypt.
- The header is authenticated too, so the key version can't be altered.
- The key version travels inside the ciphertext. No separate `key_version` column is needed,
  and [rotation](#rotating-the-master-key) can re-wrap row by row.

## What is encrypted

Provider credentials (Plaid access tokens, household Plaid secrets), account numbers, account and
transaction notes, receipt files, OCR text, AI conversations, and TOTP seeds. Amounts, dates,
categories, and merchant names are **not** field-encrypted, because reporting needs SQL over them.
They rely on disk/volume encryption and database access control (ADR 0005).

## Crypto-shredding

Deleting a household deletes its `household_keys` rows. Everything encrypted with those keys,
**including copies in old database backups**, becomes permanently unreadable.

## Operator checklist

1. **Generate** the key once: `openssl rand -base64 32`. Prefer `APP_ENCRYPTION_KEY_FILE`
   (Docker/Proxmox secret) over a plain env var.
2. **Back it up separately from database backups**, e.g. in a password manager, not next to the
   `pg_dump` files:
   - **Losing the key** = losing every encrypted field (bank connections must be re-linked, notes
     are gone).
   - **Storing it with the backups** = anyone who steals the backups can read those fields.
3. **Encrypt the backups too**, to an age key whose private half is also kept off the server, and
   put the database volume on an encrypted disk ([backups](backups.md)).
4. Every service that reads household data (api, worker) needs the **same** key and version.
5. **Never change the key in place.** Replacing it makes existing data unreadable. To change it,
   [rotate](#rotating-the-master-key) it.

## Where keys come from

The master key comes from a **key provider** (`KeyProvider` in `packages/crypto`, ADR 0014 §2.2),
never from the database or the image. Self-hosting uses the environment one: `APP_ENCRYPTION_KEY`,
or `APP_ENCRYPTION_KEY_FILE` pointing to a Docker or Proxmox secret. A KMS-backed provider can be
added behind the same interface when hosting needs it.

Loading **fails closed**: the api and worker don't start, and say why, if a key is missing, isn't
32 base64 bytes, or a rotation's settings can't work (a previous key without its version, two keys
with one version, or the same key twice). Data wrapped with a master key version that isn't loaded
is refused with a `MasterKeyNotLoadedError` naming the version, never read with another key.

## Rotating the master key

Rotation (#25) replaces the master key without re-encrypting any data: each household's data key
is unwrapped with the old master key and wrapped again with the new one. Fiscus stays up
throughout, reading with either key and writing with the new one.

1. **Generate the new key**: `openssl rand -base64 32`, and store it as you did the first one.
2. **Load both.** In `.env`, the new key takes the old one's place with a higher version, and the
   old one moves to `_PREVIOUS`. Set a maintenance password too:

   ```bash
   APP_ENCRYPTION_KEY=<new key>
   APP_ENCRYPTION_KEY_VERSION=2
   APP_ENCRYPTION_KEY_PREVIOUS=<old key>
   APP_ENCRYPTION_KEY_PREVIOUS_VERSION=1
   MAINTENANCE_DATABASE_PASSWORD=<openssl rand -hex 24>
   ```

   `docker compose up -d --wait` restarts the services with both, and `migrate` enables the
   `fiscus_maintenance` login.
3. **Re-wrap**: `docker compose --profile maintenance run --rm rotate-key`. It re-wraps every
   household key the old master key wraps, as an audited maintenance job
   (`maintenance.master-key-rewrap`), and is safe to run again. It exits 0 once everything uses
   the new key; `--check` reports without changing anything.
4. **Remove the old key** from `.env` (`APP_ENCRYPTION_KEY_PREVIOUS*`, and
   `MAINTENANCE_DATABASE_PASSWORD`), then `docker compose up -d --wait`.
5. **Keep a copy of the old key while you keep backups from before the rotation.** Their household
   keys are wrapped with it: restoring one needs it as `APP_ENCRYPTION_KEY_PREVIOUS` until
   `rotate-key` has run on the restored database. Once those backups have aged out, destroy it.

CSRF tokens signed with the old key keep working while it's loaded. Sessions aren't affected.

`scripts/rotation-drill.sh` runs this against a stack, and CI runs it after the end-to-end tests:
both keys loaded, `rotate-key`, then the new key alone opens every household's data key, and the
old key alone opens none.
