# ADR 0005: Multi-household tenancy and trusted-operator security model

- Status: Accepted
- Date: 2026-09-30

## Context
One instance should be able to host several unrelated households (friends and family on the
maintainer's Proxmox cluster, or a community instance). Households must be isolated from each
other. We also have to be honest about what the instance operator can see.

Zero-knowledge encryption, where keys are derived from user passwords and only unlocked in a
session or on the client, was considered and rejected for v1:

- Background work (aggregation sync, rules, categorization, recurring detection, alerts,
  digests, net-worth snapshots, MCP) needs plaintext while no user is logged in.
- Encrypted columns defeat SQL aggregation, search, and indexes, which conflicts with ADR 0002.
- It does not stop a malicious operator anyway. Plaid returns plaintext to the server, and
  session keys live in server memory.
- Real E2EE forces client-side compute, i.e. a local-first architecture, which is explicitly
  not wanted.

## Decision

### 1. Tenancy
- A **household** is the tenancy boundary. Every financial row carries `household_id`.
- Users can belong to multiple households. Household roles are `owner`, `member`, and `viewer`.
  Within a household, the `owner` role manages membership but cannot see other members'
  `private`/`balance_only` accounts. See ADR 0006.
- Scoping is enforced in two layers:
  - **Application:** a request-scoped `HouseholdContext`, with repository helpers that
    always filter by `household_id`. Lint and tests guard against unscoped queries.
  - **Database:** PostgreSQL Row-Level Security policies keyed on
    `current_setting('app.household_id')`. The API and worker set it per transaction.
    This is a backstop against application bugs.
- Signup mode is configurable: `open`, `invite_only` (default), or `closed`.

### 2. Separate instance-admin and household roles
- The **instance admin** role manages users, households (create, disable, delete), invites,
  instance settings, provider config, backups, and health. It is **not** a member of any
  household by virtue of being admin.
- Admin API endpoints return household *metadata only*: name, member emails, account count,
  connection health, storage used. They never return transactions, balances, notes, or receipts.
- An admin who is also a person with their own finances uses a normal household membership,
  like anyone else.

### 3. Envelope encryption with per-household keys
- A **master key (KEK)** is loaded from `APP_ENCRYPTION_KEY`, or from `APP_ENCRYPTION_KEY_FILE`
  for Docker/Proxmox secrets. It is never stored in the database. A `KeyProvider` interface
  allows a future KMS or Vault backend.
- Each household has a **data key (DEK)**, randomly generated, stored *wrapped* by the KEK in
  `household_keys` with a key version.
- Encrypted with the household DEK (AES-256-GCM, via a single `CryptoService`):
  - provider credentials: Plaid access tokens, SimpleFIN access URLs
  - account numbers / masks beyond the last 4
  - free-text notes, receipt files at rest, and OCR text
- **Not** encrypted at the field level: amounts, dates, categories, and merchant names. These
  are needed for SQL reporting and search, and are protected by disk/volume encryption and
  database access controls.
- **Crypto-shredding:** deleting a household destroys its DEK, so its data in old backups can't be read.
- **Rotation:** the KEK is rotated by re-wrapping DEKs, which is cheap. A DEK is rotated by a
  background re-encryption job.

### 4. Audit log
- Append-only `audit_events` record the actor, action, target household, IP, and timestamp.
- Every instance-admin action that touches a household (disable, delete, reset member MFA,
  change provider config) is logged. **Household owners can view** the events that affect
  their household.
- Sensitive household actions are also logged: member changes, connection added or removed,
  exports, PAT creation.

### 5. Documented trust model
The README and install docs state plainly:

> The operator of an instance can technically access your data. Only join an instance run by
> someone you would trust with your bank statements, or run your own.

### 6. Future option (not v1): "sealed household"
All encryption goes through `CryptoService`/`KeyProvider`. That allows an opt-in mode later
where the household DEK is wrapped by a user-held key and only unlocked while a session is
active, accepting that processing and alerts are degraded while it is locked.

## Consequences
- All features, including background sync and notifications, work for every household.
- Household isolation is defended at both the app and DB layers, which prevents cross-tenant bugs.
- The operator's access is limited by policy, audit, and role separation, **not** by
  cryptography. This is disclosed rather than hidden.
- Losing `APP_ENCRYPTION_KEY` makes all encrypted fields unrecoverable. Backup docs must
  cover backing up the key separately from the database.
- RLS adds some complexity: connection pooling must set `app.household_id` per transaction, and
  migrations and admin jobs use a separate role that bypasses RLS.
