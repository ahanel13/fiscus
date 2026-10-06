# Categories and transactions (M1 Phase 2)

- Status: Accepted (#290). Database layer: migrations `0011_ledger`, `0012_ledger_rls`
- Tickets: #37, #36, #54, #59, #38, #39, #281, and the transaction half of #61
- Builds on: [data model §3.5](data-model.md#35-transactions), [permissions](permissions.md) §3, §4.3–4.6, [ADR 0006](../adr/0006-shared-finances-yours-mine-ours.md) §3, §5, [accounts and visibility](accounts-and-visibility.md)

The tables are already in the data model. This document decides the behavior they leave open:
default categories, how manual balances follow transactions, the privacy rules for attributed
purchases (F1), splits, and the API. Phase 4 adds imports, the review queue, and rules on top.

## 1. Categories (#37)

- Categories are **household-wide** (ADR 0006 §6). Each belongs to a **group** with a budget
  `kind`: `income`, `fixed`, `flexible`, `non_monthly`, `savings`, or `transfer`. Budgets (M3) use the kind.
- A new household gets this **default set**. Members edit it freely; nothing depends on the names.

| Group (kind) | Categories |
|---|---|
| Income (income) | Paychecks · Interest · Other income |
| Home (fixed) | Rent or mortgage · Utilities · Internet and phone · Home insurance · Home maintenance |
| Food (flexible) | Groceries · Restaurants · Coffee |
| Transportation (flexible) | Gas · Public transit · Parking and tolls · Car maintenance · Car insurance |
| Shopping (flexible) | Clothing · Household supplies · Electronics |
| Health (flexible) | Medical · Pharmacy · Fitness |
| Fun (flexible) | Entertainment · Subscriptions · Hobbies |
| Travel (non_monthly) | Flights · Lodging · Travel other |
| Family and pets (flexible) | Childcare · Kids · Pets |
| Gifts and giving (non_monthly) | Gifts · Charity |
| Financial (fixed) | Loan payments · Fees · Taxes |
| Savings (savings) | Savings transfers · Investments |
| Transfers (transfer) | **Transfer** · **Settlement** (system) |
| Other (flexible) | **Uncategorized** (system) · Miscellaneous |

- **System categories** (`uncategorized`, `transfer`, `settlement`) can be renamed but not deleted (CAT-04).
- The set lives in one place, the SQL function `fiscus_seed_default_categories()`, which seeds new
  households and backfilled existing ones.
- **Deleting a category in use** asks for a replacement, and moves every transaction to it,
  including ones the deleting member can't see. It reports only the count of affected *visible*
  rows, so nothing leaks (CAT-03). Archiving hides a category from pickers but keeps its history.

## 2. Transactions (#36)

### Sources and what can be edited (TXN-02/03)
| Source | Created by | Amount, description | Date |
|---|---|---|---|
| `manual` | Owners of the account | Editable | Editable (sets the date directly) |
| `import`, `provider` (Phase 4, M2) | The import or sync | Read-only | **Date override** only (#281, data model §3.5) |

- New manual transactions are `reviewed` (you entered them). Imports and bank sync arrive as `needs_review`.
- Deleting is a soft delete (`deleted_at`). Manual transactions are purged after 30 days (undo
  window); provider tombstones stay so sync can't bring them back (data model §6).

### Manual balances follow transactions
For accounts in `transactions` mode ([accounts §5](accounts-and-visibility.md#5-balances)),
balances you entered by hand become **anchors**, and every other day is computed:

- **After an anchor:** the anchor plus the transactions after it, up to that day.
- **Before the first anchor:** the first anchor minus the transactions between that day and the
  anchor. So entering today's balance and some past transactions builds the history backward,
  as Monarch does.
- Computed days are stored as `balance_snapshots` with `source = computed`, rewritten **in the
  same transaction** as the change, from the changed date onward (only the affected account).
  Manual volumes are small; bank sync (M2) moves this into the worker.
- Anchors always win: a computed value never overwrites an entered one.
- An entered balance is the balance **at the end of that day**, so it already includes that day's
  transactions: copying today's balance from your bank and then recording today's purchases
  doesn't count them twice. The balance fields say so.

### Pagination, filters, search
- Ordered by `effective_date DESC, id DESC`, with an opaque cursor (API conventions §6).
- Filters: accounts, categories, tags, members (attribution), date window, amount range,
  review status, `excluded`, and text search over the display name and original description
  (`pg_trgm`). Notes aren't searchable in SQL, since they're encrypted (data model §8).
- `lens` follows **attribution** for spending views (ADR 0006 §5): `me` = attributed only to
  me, `member:<id>` = only to them, `shared` = attributed to two or more, `all` = everything visible.

### Bulk edit
`PATCH transactions` with `{ ids, changes }` for category, tags, review status, and exclude.
Each row is checked on its own: the response lists which succeeded and which were refused (and why),
and one activity event records the batch with the ids and fields changed.

## 3. Who it's for: attribution (#54) and the payer (#59, F1)

- **Who paid** is the account. **Who it's for** is attribution: `transaction_attributions`
  rows with shares in basis points. No rows means "the account's owners, in their shares".
- **Setting attribution** (ATT-01): owners of the paying account only. `full` visibility isn't enough.
  Changes go to the activity feed so the people affected can see them (F6). Flagging and
  disputes arrive with settle-up (M3).
- **Attributing to someone shares that transaction with them**, even from an account they can't
  see (ATT-02). The database policy for transactions has an attribution branch:

  ```sql
  account_id IN (SELECT account_id FROM fiscus_account_access()
                 WHERE level IN ('owner', 'full', 'view_only'))
  OR EXISTS (SELECT 1 FROM transaction_attributions ta
             WHERE ta.transaction_id = transactions.id AND ta.member_id = fiscus_member())
  ```
- **The account stays hidden (F1).** When a transaction is visible only through attribution,
  the API omits `accountId`, the account name, and its mask, and returns **`paidBy`**: the
  paying account's owners as members ("Paid by Ada"). Nothing says a private account exists.
  The cross-member suite (#56) gets these cases, and a test scans responses for the hidden account.
- **Transfers** between an account you can see and one you can't show the other side as the
  member ("Transfer to Ada"), never as an account (ADR 0006 consequences).

## 4. Splits (#38)

- Splitting turns a transaction into a **parent** (`has_splits = true`) with **children**
  (`parent_id`), each with its own amount, category, attribution, and note. Children must add up
  to the parent exactly; the API enforces it, and a commit-time check backs it up.
- **Totals count only rows without splits** (the parent or its children, never both; data model §3.5).
- Owners of the paying account split and unsplit (TXN-06). Unsplitting deletes the children
  and keeps the parent's own category.
- A split child shares the parent's account, date, and visibility. Attributing a child to
  someone shares **that child** with them, and the API shows its parent's date, description,
  and payer, never the other children.

## 5. Tags and notes (#39)

- **Tags** are household-wide labels with a color. Anyone who can categorize a transaction
  (TXN-04: owners and `full`) can tag it.
- **Two kinds of notes** (data model): one **shared note** per transaction, visible to anyone who
  can see the transaction and written by owners, `full` members, or anyone it's attributed to
  (NOTE-02); and a **private note** per member, visible only to its author. Both are encrypted.

## 6. New members and history (#256, ADR 0012)

**Sharing an account shares its history.** A member who joins later sees every transaction on
the accounts shared with them, whatever the date, plus anything attributed to them (ADR 0012:
"…or if someone shares an account with them").

The new-member **history window** (`history_from`) limits *household-level* shared records:
shared budgets, settle-up between other members, and household reports. Those arrive in M3 and
M7, so the window is built with them; it doesn't apply to transactions.

## 7. API

All under `/api/v1/households/:householdId/`.

| Route | Who | Notes |
|---|---|---|
| `GET`/`POST category-groups`, `categories`; `PATCH`, `DELETE …/:id` | Read: all · write: OWN, MEM (CAT-01–04) | `DELETE` takes `replaceWith` |
| `GET transactions?…` | Visible (TXN-01) | Filters, `lens`, cursor. F1 serialization |
| `POST transactions` | Owners of the account (TXN-02) | Manual |
| `GET`/`PATCH`/`DELETE transactions/:id` | Per field: TXN-03/04/05, ATT-01, #281 | `If-Match`, first save wins per field |
| `PATCH transactions` | Per row | Bulk edit |
| `PUT transactions/:id/splits`, `DELETE …/splits` | Owners (TXN-06) | |
| `PUT transactions/:id/attribution` | Owners (ATT-01) | `[{memberId, shareBps}]`, or `[]` to inherit |
| `PUT`/`DELETE transactions/:id/notes/shared`, `…/notes/mine` | NOTE-02 / NOTE-03 | |
| `GET`/`POST`/`PATCH`/`DELETE tags` | Read: all · write: OWN, MEM | |

## 8. Web

- **Transactions page**: a dense, keyboard-friendly table (date, merchant, category, whose, amount),
  grouped by day, with filters, search, and multi-select bulk actions. Infinite scroll by cursor.
- **Transaction drawer**: edit category, tags, date (with "Bank date: …" for imported rows),
  attribution ("For: Mine · Ada's · Ours · custom"), split editor, shared note, and my note.
- **Paid by someone else**: rows shared through attribution show "Paid by Ada" in place of the account.
- **Account page**: its transactions under History, and balances computed from them.
- **Categories and tags** in Household settings.

## 9. Decisions to confirm in review
1. **The default category set** in §1, and that defaults are only a starting point.
2. **Balances computed from transactions** around hand-entered anchors, including backward from the first anchor (§2).
3. **Attribution reveals the transaction, never the account**, with "Paid by …" (§3). Already decided in ADR 0006; restated because it shapes the whole API.
4. **Split children** are shared individually through attribution, without their siblings (§4).
5. **History window** for new members applies to transactions only, not to balances (§6).

## 10. As built: database
- **Effective date** is a generated column: the date override, else the posted date, else the
  authorized date. The household "authorized date" basis (#69, Phase 3) adds a second generated
  column, since a stored column can't read the household's setting.
- **Visibility** (migration 0012): the policy in §3, with the attribution branch through the
  read-only definer function `fiscus_attributed_to_me()`. `fiscus_attributed_payers()` names the
  payers (as members) for "Paid by …" without revealing the account.
- **Private notes** are visible only to their author, including to household owners and system jobs.
- **Commit-time checks:** attribution shares sum to 10 000; attributed members are current
  members; splits are one level deep, on the parent's account and currency, with at least two
  parts adding up to the parent exactly.
- Search uses `pg_trgm` GIN indexes on the display name and original description.

## 11. As built: API
- **Viewers are read-only** for transactions (no categorizing or shared notes), whatever an
  account's visibility allows. The permissions matrix tests caught the first version allowing it.
- **Lists show split parts, not split parents**, so lists and totals always agree; parts carry
  `parentId`.
- **Bulk edits** record one activity event per account, so each is visible only to members who
  can see that account.
- **Private notes** are recorded as activity that's visible only to the author's own audit.
- Reading a transaction you can see but not change answers `403`, not `404`, even though
  Postgres hides it from a locked read.
- **Attribution changes** on a hidden account are recorded against that account, so the person
  it's attributed to doesn't see the event in the feed (they see the current attribution on the
  transaction). Notifying them is part of flags and disputes (M3).
