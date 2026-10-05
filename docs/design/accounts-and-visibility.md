# Accounts, ownership, and visibility (M1 Phase 1)

- Status: Accepted (#285). Database layer built in migrations `0009_accounts` and `0010_accounts_rls`
- Tickets: #51, #35, #52, #53, #20, #55, #56 (and the account half of #61)
- Builds on: [data model §3.3, §4](data-model.md), [permissions](permissions.md) §3 and §4.2, [ADR 0006](../adr/0006-shared-finances-yours-mine-ours.md), [ADR 0013](../adr/0013-tamper-evident-activity-history.md)

The *rules* are already decided: who sees what is in ADR 0006 and the permissions matrix. This
document decides **how to build them** and settles the gaps they leave. Phase 2 (transactions)
reuses everything here, so the privacy core is built and tested once.

## 1. What ships in Phase 1

| Area | Delivered |
|---|---|
| Members (#51) | Already built in M0 (name, color, role). Avatars are **initials on the member color** (the `Avatar` component); uploaded photos wait for file storage (M9) |
| Accounts (#35) | Manual accounts of every type: create, edit, close/reopen, notes, balance history, net worth |
| Ownership (#52) | Personal or joint, shares in basis points, add/remove owners, defaults from the finance style |
| Visibility (#53) | `full` / `view_only` / `balance_only` / `private`, enforced by Postgres RLS (#20) |
| Lens (#55) | `lens` on every money read endpoint (accounts, balances, net worth); spending lenses arrive with transactions |
| Leakage suite (#56) | Generated cross-member tests at the API and database levels, plus aggregate checks |
| Activity | Account changes recorded (ADR 0013) and the activity feed filtered per member |
| Web | Accounts page, account detail (balances, settings), add-account dialog, net worth "visible to you" |

Bank-linked accounts (`connection_id`) arrive in M2; the column exists now without its foreign key.

## 2. Schema

Migrations `0009_accounts` (tables) and `0010_accounts_rls` (policies and triggers), expand-only per [upgrades](upgrades.md):

- **`accounts`**: as in data model §3.3, plus:
  - `balance_mode` enum `transactions` / `value`, see §5;
  - `field_versions jsonb` for first-save-wins edits ([API conventions §8](api-conventions.md)).

  `connection_id` has no foreign key until M2 creates `connections`. `name` and `official_name` stay plaintext so they're searchable; `notes_enc` and `account_number_enc` are encrypted with the household key.
- **`account_owners`** `(account_id, member_id)` PK, `household_id`, `share_bps`.
- **`balance_snapshots`** `(account_id, as_of)` PK, `household_id`, `balance_minor`, `available_minor`, `credit_limit_minor`, `source`.
- Every table gets the household-isolation policy, the account-visibility policy (§3), and the
  `fiscus_mark_household_write` trigger (activity enforcement). The coverage test already fails if one is missing.

**Sign convention** (data model §1): balances are from the holder's view, so a credit card owing
$500 is `-50000`, and net worth is a plain sum.

### Invariants (deferred constraint triggers, checked at commit)
1. Every account has **≥ 1 owner**, and shares sum to **exactly 10 000**.
2. Owners are **active members of the same household** with role `owner` or `member`. Viewers can't own (EDGE-05).
3. A member who owns accounts can't be demoted to viewer (HH-06) or leave, until the departure flow (#62) hands their accounts over (`409 owns_accounts`).
4. Composite foreign keys keep owners and snapshots in the account's household.

Equal shares are split by the API with the remainder going to the first owner, e.g. three owners → 3 334 / 3 333 / 3 333.

## 3. Enforcing visibility in the database

### Decision: compute access per statement, instead of a derived table
The data model planned `member_account_access`, a table kept up to date by triggers. This
document proposes replacing it with one read-only function:

```sql
fiscus_account_access() RETURNS TABLE (account_id uuid, level account_access_level)
-- SECURITY DEFINER, owned by fiscus_definer (read-only), STABLE.
-- For the context member: 'owner' where they're in account_owners; otherwise the account's
-- visibility (full / view_only / balance_only); private accounts they don't own are absent.
-- System context: every account in the context household at 'owner'.
```

Policies read it as an uncorrelated subquery, which Postgres evaluates **once per statement**:

```sql
-- accounts, balance_snapshots, account_owners
USING ((SELECT fiscus_context_valid())
       AND household_id = fiscus_household()
       AND account_id IN (SELECT account_id FROM fiscus_account_access()))
```

Transactions (Phase 2) add `level IN ('owner','full','view_only')` plus the attribution branch (F1).

| | Derived table (planned) | Function (proposed) |
|---|---|---|
| Correctness | Triggers on 3 tables must keep it in sync. A missed path silently over- or under-shares | Nothing to drift: the answer is computed from the source rows every time |
| Privilege | Triggers must **write** across members' rows, so a definer role needs write access | Fits the existing **read-only** `fiscus_definer` pattern: a bug can't change data |
| Speed | Indexed lookup | One small query per statement; a household has tens of accounts, not thousands. A test asserts the plan evaluates it once (no per-row calls) |
| Caches (EDGE-08) | Invalidated by the table's trigger | No access caches exist yet. Report caches (M7) key on an access fingerprint from the same function |

If profiling later shows a need, the function can be backed by a table without changing any policy.

### What each level allows (permissions §3, unchanged)
`owner` > `full` > `view_only` > `balance_only`. All four see the account, its balances, and its
contribution to net worth. Account notes need `view_only` or above. The account number is
owner-only. Phase 2 adds transactions (`view_only`+) and categorizing (`full`+).

## 4. API

All routes live under `/api/v1/households/:householdId/`. **Not visible ⇒ 404**, and **visible but not allowed ⇒ 403** with a code.

| Route | Who (permissions) | Notes |
|---|---|---|
| `GET accounts?lens=&include=closed` | vis (ACC-05) | Each item has `ownership` (`mine` / `member:<id>` / `joint`), `owners` with shares, `visibility`, `yourAccess` (level), `balance` (latest snapshot) |
| `POST accounts` | OWN, MEM (ACC-04) | Creator is the sole owner unless `owners` is given. Defaults to the finance style's visibility (ADR 0006 §8) |
| `GET accounts/:id` | vis | Adds `notes` (`view_only`+), and `accountNumber` for owners only, on request (`?reveal=number`; audit-logged) |
| `PATCH accounts/:id` | owner (ACC-06/07/11) | `If-Match` + field-level first-save-wins. Visibility changes go to the activity feed. `private` on a joint account in a 2-member household → `422 private_joint_disallowed` (F2) |
| `PUT accounts/:id/owners` | owner (ACC-08) | Replaces the owner set. You can **remove only yourself** from a joint account. Added owners are notified and can remove themselves |
| `POST accounts/:id/close`, `…/reopen` | owner (ACC-09) | History kept. Permanent delete is a later ticket (needs co-owner approval) |
| `GET accounts/:id/balances?range=` | vis | Snapshots for the range (ADR 0011 carry-forward) |
| `PUT accounts/:id/balances/:date` | owner | Set a balance for a day (`value` mode, or an anchor in `transactions` mode) |
| `GET net-worth?lens=&range=` | vis | `{ assets, liabilities, netWorth, series }`, labeled with `meta.scope = "visible_to_you"` (F3) |

### Lens for money views (ADR 0006 §5, F6)
Built once in a `VisibilityScope` (`apps/api/src/visibility/`) from the request context and `lens`.
Every money query goes through it; nothing filters accounts by hand.

| Lens | Accounts included (always ∩ visible to caller) | Weight in totals |
|---|---|---|
| `all` (default) | Every visible account | 1 |
| `me` | Accounts I own, alone or jointly | My share |
| `member:<id>` | Accounts that member owns | Their share |
| `shared` | Joint accounts (≥ 2 owners) | 1 |

An unknown or departed member in `lens` → `422 invalid_lens`. Single-member households accept
only `all`/`me` (the switcher is hidden).

## 5. Balances

| Mode | For | How the balance moves |
|---|---|---|
| `transactions` | Checking, savings, credit, loans, cash (default for `depository`, `credit`, `loan`) | **Opening balance + transactions.** Until Phase 2, people set balances by hand, which become anchors |
| `value` | House, car, collectibles, other assets (default for `property`, `vehicle`, `other`, `investment`, `crypto`) | Updated by hand ("My house is worth $410,000 as of today") |

- One snapshot per account per day (`as_of` is a calendar date in the household time zone).
  Setting today's balance twice keeps the last value.
- Net-worth history carries each account's last snapshot forward to later days (ADR 0011), so
  rarely-updated assets don't drop to zero between updates.
- Bank-synced balances (M2) arrive as `source = provider` snapshots in the same table.

## 6. Activity and privacy

The activity feed (ADR 0013) must not reveal accounts the viewer can't see. Even "Alex created an
account" leaks that a private account exists (F3).

- **`audit_events.account_id`** (new, nullable) records the account an event concerns. It's part
  of the hashed fields only when present, so existing chains still verify.
- The feed and the owner's audit log (HH-11) show an event only if it has no `account_id` or the
  caller can see that account.
- **Cursors become opaque.** Today the feed exposes `seq`, and gaps in it would reveal that hidden
  events exist. Chain verification still checks every event, but members see only `ok` or `broken`,
  without counts or positions of events they can't see.

Account events: `account.created`, `account.updated` (field names in metadata, values in the
encrypted `changes`), `account.visibility_changed`, `account.owners_changed`, `account.closed`,
`account.reopened`, `account.balance_set`, `account.number_revealed`.

## 7. Tests (#56)

1. **Database level** (as in #19): raw SQL under forged contexts for every (actor × account) pair. A
   member sees exactly the rows their level allows, and system context sees everything.
2. **API level, generated**: one fixture household with members **A** (owner), **B** (member),
   **C** (member), and **V** (viewer), and accounts in every combination of
   {personal A, joint A+B, joint A+B+C} × {full, view_only, balance_only, private}. A table of
   expected levels drives tests that call every account route as every actor and assert:
   - the status code (`200` / `403` / `404`);
   - that no response contains an ID, name, number, or note the actor shouldn't see. Bodies are
     scanned for every hidden account's identifiers.
3. **Aggregates**: net worth and totals for every actor × lens equal a brute-force sum over only
   the accounts that actor can see.
4. **Activity**: each actor's feed contains no events about invisible accounts.
5. **Invariants**: ownership triggers (no owners, shares ≠ 10 000, viewer owner, cross-household
   owner) and F2 all fail as specified.
6. The **cross-household suite** covers the new routes automatically.

## 8. Web

- **Accounts page:** grouped by type (cash, credit, loans, investments, property, other), with
  totals per group and net worth "visible to you". Each account shows the viewer-relative owner
  label (*Mine* · *Alex's* · *Ours*) and a visibility badge on accounts you own. It follows the lens.
- **Add account:** name, type (subtype optional), currency, opening balance and date. Owner and
  visibility come from the finance style and can be changed in the dialog.
- **Account detail:** balance history (table plus a simple sparkline; full charts are M7), "Update
  balance", notes, and a **Settings** tab with ownership, shares, visibility, and close. Each
  visibility option shows one sentence on what others will see.
- Net worth on the dashboard waits for M7. Phase 1 shows it on the Accounts page.

## 9. Decisions to confirm in review
1. **Compute access per statement** (§3), replacing the planned trigger-maintained table.
2. **Balance modes**: the `transactions` and `value` defaults by account type (§5).
3. **Being made a co-owner** needs no acceptance, but the new owner is notified and can remove
   themselves at any time (ACC-08 already allows removing yourself). The alternative is an
   invitation-style request.
4. **Avatars** are initials on the member color until uploads exist (M9).
5. **Activity privacy** (§6): an `account_id` on events, opaque cursors, and verification that
   reports only ok or broken to members.
