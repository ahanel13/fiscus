# ADR 0013: Always-on, tamper-evident activity history

- Status: Accepted
- Date: 2026-10-02
- Extends: [ADR 0005](0005-tenancy-and-trust-model.md) §4 (audit log), [ADR 0012](0012-member-lifecycle.md) (departures)

## Context
Shared finances invite disputes: a partner who quietly re-attributes purchases, a roommate who
deletes a shared bill, a household member who edits last month's numbers after an argument.
These risks exist all the time, not only during a breakup, so protection must not depend on
someone remembering to switch on a special mode.

The instance operator is trusted (ADR 0005). Someone with direct database access and the master
key can always change data, and nothing in software fully prevents that. But it can be made
**detectable**.

## Decision

### 1. Every change is recorded, always
Every create, update, delete, and state change to household data writes an **activity record**,
in the same transaction as the change:

- **who:** member, AI assistant (on behalf of a member, with the change set), system job,
  instance admin, or PAT;
- **when**, and **what**: target type and id, and the fields changed;
- **before and after values**, stored in `changes_enc`, encrypted with the household data key
  (#21) because they can contain financial details. Non-sensitive metadata stays plaintext for
  indexing.

This builds on `audit_events` (#23) and powers the per-transaction edit history (TXN-11), the
attribution activity feed (F6), and the household activity view (HH-11/12).

**Visibility:** a member sees history entries only for records they can currently see, and
before/after values only for fields they could see (permissions §3). History never leaks hidden
data.

### 2. Nothing is silently deleted
User-facing deletes of household data are **tombstones**. The row is hidden from normal views,
and its activity record keeps the deleted values (encrypted). Hard removal happens only through
documented retention paths, each of which leaves an activity record:
- the 30-day purge of deleted manual transactions;
- import-batch reverts;
- whole-household crypto-shred, where everything, including history, becomes unreadable at once.

### 3. The application can't rewrite history
- `fiscus_app` can only insert into and read `audit_events`. `UPDATE`, `DELETE`, and
  `TRUNCATE` are revoked (migration `0003`, tested).
- There is **no admin or user endpoint** that edits or removes history. Instance-admin actions
  are themselves recorded and visible to the affected household (ADR 0005).

### 4. Tampering is detectable, including by the operator
Each household's activity forms a **hash chain**:

```
entry_hash(n) = SHA-256( entry_hash(n-1) ‖ canonical(entry n) )
```

`canonical(entry)` covers every stored field, including the ciphertext of `changes_enc`. Changing,
inserting, reordering, or deleting any past entry breaks every later hash.

- **Verification:** `GET /api/v1/households/:id/activity/verify` recomputes the chain (or the
  part since a checkpoint) and returns the head hash and sequence number.
- **Witnesses outside the database**, so a full rewrite of the chain is also caught:
  - each member's browser stores the last head it saw and checks on every visit that the new
    chain **extends** it;
  - household exports, departure packages, and weekly digest emails (M4) include the head hash
    and sequence number;
  - optionally (later), a household can publish signed checkpoints to a location the operator
    doesn't control (a webhook or a file a member keeps).
- **On a mismatch**, the app shows every member a prominent "history integrity check failed"
  warning, with the last verified point, and records the event. It cannot prevent the
  tampering, but it makes it **visible**.
- Chains are **per household**, so moving out (ADR 0012) starts the new household's chain with a
  genesis entry referencing the old household's head at departure.

### 5. Relationship to departure protection
Departure protection mode (ADR 0012) is still useful, with a narrower job: it **stops edits** to
past shared records during a dispute. Recording and integrity checking (§1–4) happen all the
time, for everyone.

## As built (#263, #23)
- `audit_events` gained `scope_id` (household, or the nil UUID for instance events), `seq`, `entry_hash`, and `changes_enc`. `audit_chain_heads` holds each chain's head and is locked on append (`appendActivity` in `@fiscus/db`).
- Canonical form: JSON with keys sorted at every level, Dates as ISO, Buffers as base64; the IP is normalized through Postgres `inet` before hashing.
- `changes_enc` is bound to its entry by associated data (`scope:seq`).
- Enforcement: a row trigger (`fiscus_mark_household_write`) on every household table sets a transaction-local flag. `HouseholdScope` rolls back any transaction that changed household rows without recording activity. Row locks and no-op statements don't trip it. (An earlier attempt used Postgres's per-transaction statistics, which reported stale counts on pooled connections.)
- Endpoints: `GET /api/v1/households/:id/activity` (household-visible events, decrypted changes, `before` cursor) and `GET …/activity/verify`.
- Events recorded before this change have no `seq` and are outside the chain.

## Consequences
- Disputes become resolvable: "who changed this, and from what?" always has an answer.
- Sneaky edits are visible to the other members, and edits made outside the app (directly in the
  database) are detectable.
- Every write path must record activity in the same transaction. This is enforced in the
  data-access layer (#18) so it can't be forgotten, and in the Definition of Done.
- Storage grows with activity. Records are small, `changes_enc` holds only changed fields, and
  history lives as long as the household does.
- Hash chaining serializes appends per household (a row lock on the chain head). That's
  acceptable at household write rates.
- Limits, stated plainly: an operator who controls the server, the master key, **and** every
  member's browser and email could still hide changes. This is evidence, not prevention, and the
  docs say so.
