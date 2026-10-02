# ADR 0012: Member lifecycle: joining, privacy, claiming a profile, and leaving

- Status: Accepted
- Date: 2026-10-02
- Extends: [ADR 0006](0006-shared-finances-yours-mine-ours.md) §9 (member lifecycle), [ADR 0005](0005-tenancy-and-trust-model.md) (tenancy, encryption)
- Related: #223 (members without logins), #62 (separation flow)

## Context
Households change over time, and the same mechanics must serve **families, couples, and
roommates**:

- A child tracked as a dependent grows up and wants a login and privacy.
- A teenager stays in the family household but doesn't want every purchase visible.
- An adult child moves out and wants their own household with their history.
- A couple separates or divorces, possibly without cooperating, occasionally in bad faith.
- Roommates come and go: a new roommate joins mid-lease, another moves out mid-month.

Everything below uses neutral terms ("member", "departure"). Nothing is specific to marriage or
family; a breakup between roommates uses exactly the same flows.

"Create a new household by hand and re-enter everything" loses history and invites mistakes.
Doing this well also depends on decisions that must be made **now**, while the data model is
being built.

## Decision

Independence is a **spectrum of three steps**. Most households only need the first one or two.
Joining (§Joining) and leaving (§Departures) apply to every kind of household.

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

**Who:** the member themselves, with a login. This is the "own accounts" half of every departure
package (§Departures). A household owner **cannot block it**: it is the
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
| **Joint** accounts | Per account, chosen in the preview: **stay** (the leaver is removed as owner and shares are redistributed), or **transfer** to the leaver, which **requires the co-owners' approval**. Either way, the leaver's **read-only history snapshot** is included without approval (§Departures) |
| Purchases on **others'** accounts attributed to the leaver | **Stay** with the old household; that's the payer's data. The leaver loses access once they've left |
| Personal budgets, goals, plans, rules, and their private AI conversations | **Move** |
| Shared budgets and goals | **Stay**. Their contribution history remains in the old household |
| Categories, category groups, tags, merchants | **Copied** (only those used by moved data), so the new household starts out matching |
| Audit events | **Stay**. Each household keeps its own log, and both record the move |

### Joining: new members see the household from their join date
A member who joins later (a new roommate, a new partner) sees **household-shared records only from
their `joined_at` date onward**: shared budgets' history, "ours" purchases among others, settle-up
between other members, and household reports. They see older records only if they are explicitly
part of them (attributed to them) or if someone shares an account with them. Earlier members'
shared history isn't the newcomer's business.

- Owners can **extend** a member's history window (e.g. a partner who should see the whole
  household's past). They can never narrow what members could already see.
- Enforced with the same visibility machinery (ADR 0006 §4, data model §4): a per-member
  `history_from` date on `household_members`, applied in queries and row-level security.
- **Split policies are effective-dated** (ADR 0006 §7). A new member's share of rent starts on
  their join date, with **proration** for partial billing periods. The same applies when someone
  leaves.

### Departures: protections for every way someone leaves
A member can leave on good terms (moving out), be removed by an owner, or leave in a dispute
(a breakup, divorce, or roommate falling-out). The rules below make departures **fair by
default**, so no member can strand another or rewrite shared history.

1. **Removal never strands someone.** When an owner removes a member who owns or co-owns
   accounts, or who is part of shared records, the removed member gets the **departure package**
   (below) instead of simply losing access. The same applies to leaving.
2. **Departure package**, available to anyone leaving, without anyone's approval:
   - their **own accounts** move to their new household (step 3);
   - a **read-only snapshot of everything they could already see** as of the departure date:
     joint accounts' history, purchases attributed to them, shared budgets and goals, and their
     settle-up ledger. It's history they already had access to, so no one can block it;
   - a **final settle-up** as of the departure date, with proration;
   - a full **export** (HH-13).

   Only **live** joint accounts and their bank connections need the co-owners' agreement to
   transfer (step 3); usually they're closed or re-titled in real life anyway.
3. **Departure protection mode.** Activity is recorded and tamper-evident all the time ([ADR 0013](0013-tamper-evident-activity-history.md)). This mode additionally *stops edits* to the past during a dispute. Any adult member (not viewers) can turn it on when a departure
   is contested. It **freezes shared history before the chosen date**:
   - no deleting joint accounts or past shared transactions;
   - no editing past attributions, splits, or settle-up entries;
   - no removing *other* members as co-owners (people can only remove themselves).

   New activity after the date continues normally. It ends when the departing members have left,
   or when all affected adult members agree. Turning it on and off is audit-logged and visible to
   the household.
4. **Departure statement.** A report as of the departure date:
   - balances and net worth split into *mine / [name]'s / ours*;
   - joint balances and each member's contributions;
   - the final settle-up between the leaver and each member.

   It's exportable as PDF or CSV for mediators, landlords, or lawyers, and is clearly labeled
   "for information, not legal or financial advice".
5. **Who keeps the household:** whoever stays. If everyone leaves, the household closes after
   each member has taken their departure package, followed by export and crypto-shred (ADR 0005).
6. **Safety.** For departures involving abuse or coercive control:
   - leaving revokes the other members' access to the leaver's moved data immediately;
   - nothing in the old household reveals the leaver's new household, accounts, or sessions;
   - a safety guide explains these protections and recommends **moving to a different Fiscus
     server** (#254) when another household member also operates the instance, since the
     operator can technically see all data (ADR 0005).

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
6. Give household-shared records an **effective date** that the per-member `history_from`
   window can filter on.

## Consequences
- Families, couples, and roommates share one set of flows: joining with a history window,
  privacy at home, claiming a profile, and leaving with a departure package.
- Departures are fair by default. No member can strand another, delete shared history, or
  rewrite who owed what, even in a dispute.
- Families get a humane path from "child on the parents' plan" to "independent adult" without
  losing history or doing data entry.
- Moving out is self-service and can't be vetoed. That protects members, but owners lose
  visibility of that history once it leaves (shared purchases stay).
- Joint accounts need a small approval workflow for transfers.
- The re-encryption job is real work, but generic: one pass over the encrypted-field registry.
