# ADR 0012: Member lifecycle: privacy, claiming a dependent profile, and moving out

- Status: Accepted
- Date: 2026-10-02
- Extends: [ADR 0006](0006-shared-finances-yours-mine-ours.md) §9 (member lifecycle), [ADR 0005](0005-tenancy-and-trust-model.md) (tenancy, encryption)
- Related: #223 (members without logins), #62 (separation flow)

## Context
Households change over time. A child tracked as a dependent grows up and wants a login and
privacy. A teenager stays in the family household but doesn't want every purchase visible. An
adult child, or a partner after a breakup, moves out and wants their own household with their
history.

"Create a new household by hand and re-enter everything" loses history and invites mistakes.
Doing this well also depends on decisions that must be made **now**, while the data model is
being built.

## Decision

Independence is a **spectrum of three steps**. Most families only need the first one or two.

### Step 1: Privacy within the household (already designed)
A member keeps their household (shared bills, budgets, a family phone plan) but sets their own
accounts to `private`, `balance_only`, or `view_only` (ADR 0006 §4). Others see only what is
deliberately shared, such as purchases attributed "ours". Nothing new is needed.

### Step 2: Claiming a dependent profile
A dependent without a login (#223), whose accounts are managed by **guardians**, gets their own
account:

1. A guardian creates a **claim link** for the dependent, bound to an email address. It works
   like an invite: single use, 7-day expiry, token only in fragments and bodies.
2. The young person sets a password (or signs in with SSO). This **attaches a login to the
   existing member row**, so their history, ownership, and attributions stay intact.
3. **Guardian rights end immediately.** The `member_guardians` rows are removed, so guardians
   lose owner-level access to the dependent's accounts at the same moment.
4. Visibility defaults to **"keep things as they are"**. Each account keeps its current
   visibility, so nothing disappears abruptly from the parents' view. Right after claiming, the
   new account holder sees a **privacy review** listing their accounts and choosing full / view
   only / balance only / private for each.
5. Their role becomes `member` (never `owner` automatically). Guardians are notified, and the
   claim is audit-logged and visible to the household.

### Step 3: Moving out (spin off into a new household)

**Who:** the member themselves, with a login. A household owner **cannot block it**: it is the
member's own data, consistent with "owners can't override privacy" (ADR 0006). Owners are
notified, and the move is audit-logged in both households. A dependent must complete step 2
first, so the person leaving always consents personally.

**Flow:**
1. **Preview:** a summary of what moves, what stays, and what is copied, with decisions for any
   joint accounts.
2. **Finalize settle-up** (ADR 0006 §7). The final balances are recorded in both households.
3. A **new household** is created with the leaver as owner. They choose its settings, defaulting
   to copies of the old household's.
4. **Data moves** (table below) in a resumable background job.
5. The leaver's membership in the old household ends (`left_at`), as in the separation flow (#62).

| Data | What happens |
|---|---|
| Accounts the leaver **solely owns** | **Move**, with full history: transactions, splits, attributions, notes (shared and their private notes), receipts, balance snapshots |
| Their bank connections | **Move** if made with the instance's Plaid keys. Connections made with the *household's own* Plaid keys (ADR 0008) can't change Plaid accounts, so they are **marked for re-link** in the new household |
| **Joint** accounts | Per account, chosen in the preview: **stay** (the leaver is removed as owner and shares are redistributed), or **transfer** to the leaver, which **requires the co-owners' approval**. Either way, an optional **read-only history copy** can go to the new household |
| Purchases on **others'** accounts attributed to the leaver | **Stay** with the old household; that's the payer's data. The leaver loses access once they've left |
| Personal budgets, goals, plans, rules, and their private AI conversations | **Move** |
| Shared budgets and goals | **Stay**. Their contribution history remains in the old household |
| Categories, category groups, tags, merchants | **Copied** (only those used by moved data), so the new household starts out matching |
| Audit events | **Stay**. Each household keeps its own log, and both record the move |

### Mechanism
- **Encryption:** every encrypted field is bound to its household by associated data (#21), so
  moving means **decrypting with the old household's key and re-encrypting with the new one**.
  This is deliberate, because data copied between households by mistake fails to decrypt.
- The job crosses households, so it runs under **`fiscus_maintenance`** (BYPASSRLS), as one of
  the allow-listed jobs (data model §4.1).
- It is **resumable and idempotent**: progress is stored in a job table, rows move in batches,
  and a crash resumes rather than duplicating. Row IDs are preserved (UUIDv7), so references
  inside the moved data stay valid.
- **Export first:** the leaver can download a full export before and after (HH-13).

### Later: portable export/import
The same move logic, serialized to a file instead of another household, becomes a **household
export/import**, letting someone move to **their own Fiscus server**. That fits the self-hosting
goal. It is a separate, later ticket.

## Design constraints adopted now
To keep step 3 a data move rather than a migration project, everything built from here on must:

1. Put **`household_id` on every household-scoped row**, including child tables such as
   splits, attributions, notes, and receipts, so a move is "update the household and
   re-encrypt", never a graph traversal.
2. Never use **foreign keys or references that cross households**.
3. Let **ownership** (`account_owners`) decide what belongs to a person. Don't infer it from who
   created a row.
4. Keep **object storage keys household-agnostic**. Receipts are stored under opaque IDs, not
   `/households/<id>/…` paths, or the move job must also relocate objects. This applies to M9
   receipts.
5. Keep encrypted fields reachable through `FieldCrypto` with a full field context, so the move
   job can re-encrypt generically.

## Consequences
- Families get a humane path from "child on the parents' plan" to "independent adult" without
  losing history or doing data entry.
- Moving out is self-service and can't be vetoed. That protects members, but owners lose
  visibility of that history once it leaves (shared purchases stay).
- Joint accounts need a small approval workflow for transfers.
- The re-encryption job is real work, but generic: one pass over the encrypted-field registry.
