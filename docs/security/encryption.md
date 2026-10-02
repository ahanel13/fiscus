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
  and rotation (#25) can re-encrypt row by row.

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
3. Every service that reads household data (api, worker) needs the **same** key and version.
4. **Never change the key in place.** Rotation (#25) increments `APP_ENCRYPTION_KEY_VERSION`
   and re-wraps data keys. Simply replacing the key makes existing data unreadable.
