# Getting data in: imports, rules, review, transfers (M1 Phase 4)

- Status: Proposed
- Tickets: #73 (CSV import), #75 (Monarch import), #41 (rules), #44 (review queue), #40 (transfers)
- Builds on: [data model §3.5, §5, §6](data-model.md), [transactions](transactions.md), [permissions](permissions.md) TXN-08/09/10, RULE-01–07, [accounts and visibility](accounts-and-visibility.md)

Phase 4 gets real history into Fiscus and keeps it tidy: bank CSV files and a Monarch export come
in with a preview that catches duplicates; rules categorize as things arrive; the review queue
makes checking them quick; transfers between your own accounts stop counting as spending.

## 1. How a file comes in

```
pick file → parse in the browser → map columns (or a saved profile) → preview → import → undo if needed
```

- **Files are parsed in the browser.** The server receives rows as JSON, never the file, and
  stores nothing but the resulting transactions: no raw files to secure, back up, or delete.
  The parser lives in `@fiscus/shared`, so the server re-validates every row with the same code.
- **Preview, then import.** `POST imports/preview` dry-runs the whole import (dedupe, rules,
  transfer matches, errors) and changes nothing. `POST imports` repeats the same steps in one
  transaction and records an **import batch**.
- **Undo:** reverting a batch soft-deletes its transactions (TXN-10: the member who imported it or
  an owner of the account). Balances recompute.
- Limits: 50 000 rows and 20 MB per import; larger files are split by date.

### Column mapping (#73)
| Field | From | Notes |
|---|---|---|
| Date | one column | Formats detected from the data (`2026-10-06`, `10/06/2026`, `06/10/2026`, `Oct 6, 2026`). If ambiguous (all days ≤ 12), we ask: month first or day first |
| Amount | one signed column, **or** separate debit and credit columns | A **sign toggle** for banks that show spending as positive. Decimal style follows the file ("1.234,56" vs "1,234.56") |
| Description | one column | Becomes the original description and the starting name |
| Category, Notes, Tags | optional | Categories matched by name (§3) |
| Account | optional | For files with several accounts (Monarch); otherwise you pick the account |
| Id | optional | A bank's own transaction id, when the file has one: used as the dedupe key instead of the hash |

A mapping can be **saved as a profile** ("Chase checking CSV") and is picked automatically when
the next file's headers match.

### Duplicates and overlaps
| Case | Detection | Default |
|---|---|---|
| **Same file row imported before** | `dedupe_key` = hash(account, reported date, amount, normalized description, occurrence index) (data model §5) | **Skipped**, shown as "Already imported" |
| **Possible overlap** with a manual or synced transaction | Same account and amount, date within ±3 days | **Flagged, not imported** until you tick it. Never silently dropped |
| Two identical rows in one file (two $4.50 coffees on the same day) | Occurrence index | Both imported |

### What imported transactions look like
- `source = import`, `needs_review` (except Monarch, §2), reported dates from the file, and the
  date-override rules from #281 apply.
- Balances: imports into a manual "follows transactions" account recompute its balance from
  your anchors (transactions §2). Bank-connected accounts (M2) keep the bank's balance.
- No $0 rows: they're listed in the preview as skipped.

## 2. Monarch import (#75)

Checked against a real export (Settings → Data, October 2026: 9 160 transactions over 40
accounts, 23 333 balance rows over 50 accounts). Monarch gives two files, each covering every
account; no per-account downloads are needed. The importer takes either or both:

**Transactions:** `Date, Merchant, Category, Account, Original Statement, Notes, Amount, Tags, Owner, Reviewed, Id`
- Dates are `YYYY-MM-DD`; amounts are plain decimals with a `.` and no thousands separator,
  already signed the Fiscus way (negative = money out). No $0 rows.
- Quoted fields can contain line breaks (notes), so we use a real CSV parser, not line splitting.
- Account names can have trailing spaces and symbols like `®`: trimmed, otherwise kept.

**Balances:** `Date, Balance, Account`, **one row per account per day** for as long as Monarch
tracked it. Some accounts appear only here (vehicles, investments, closed accounts with no
transactions in the export).

| Monarch | Fiscus |
|---|---|
| Account (from either file) | **You map each to an account**: an existing one, or a new manual account (type guessed from the name, editable). Each account gets its own batch, so one can be undone alone |
| Id | The **dedupe key**. Monarch's id is stable, so importing a newer export later adds only what's new. Rows that are otherwise identical (85 in the sample: same day, account, amount, and description) stay distinct |
| Merchant | Name (`display_name`) |
| Original Statement | Original description; the merchant when it's empty |
| Category | Matched by name to your categories; **unmatched ones are created** in a "From Monarch" group, and you can move them later. Kind: `transfer` for Transfer, Credit Card Payment, and Balance Adjustments; `income` when every transaction in it is money in; otherwise `flexible`. "Uncategorized" and "Transfer" map to the system categories |
| Tags | Comma-separated in one field; matched or created |
| Notes | The **shared note**, encrypted |
| Reviewed | `Needs Review` stays **needs review**; `Reviewed` and blank (most rows: Monarch leaves it blank unless you used its review flow) import as **reviewed** |
| Owner | `Shared`, or a person's name: names are mapped to members in the mapping step and become **who it's for** (attribution); `Shared` sets nothing |
| Balance history | **Daily balances** become the account's history: for a "follows transactions" account they're entered balances (anchors); for an account with no transactions in the export it becomes a **valued** account (value mode). The export has no "closed" flag, so it's inferred: an account whose history stops before the export date is offered as **closed** the day after its last balance (closed accounts stop counting toward net worth from that day, so a stale last balance never lingers), **ticked when that balance is $0** (clearly closed) and unticked otherwise (it may have stopped syncing, or been sold or paid off), for you to decide |

- **One step, both files.** You drop in the transactions file, the balances file, or both; the
  mapping step lists every account found in either, and confirming it creates the new accounts,
  then imports transactions, then balances, then links transfers, in one database transaction.
  Nothing has to be set up in Fiscus first; accounts you already created can be picked instead.
- Transfers: Monarch categorizes both legs but doesn't link them. After import, rows in a
  transfer category run through transfer detection (§5), so most pairs link on their own.
- Ownership and visibility of new accounts follow the household's finance style; you can change
  them in the mapping step.
- Not in the export: splits (each part arrives as a separate row, already unlinked), "hide
  from reports", and **goals**. Accounts that backed a Monarch goal import as ordinary accounts
  with their full history; the goal itself is recreated in Fiscus once goals exist (M5, #132)
  and pointed at that account.
- Size: a 1 MB, 9 000-row export is well within the limits; daily balances are inserted in bulk.

## 3. Rules (#41)

A rule is **conditions → actions**, run on transactions as they arrive (import now, bank sync in M2).

| Conditions (all must match) | Actions |
|---|---|
| Description or name: contains, equals, starts with | Rename |
| Amount: equals, between, money in or out | Set category |
| Account: one of | Add tags |
| Category: is (e.g. "Uncategorized") | Set who it's for (attribution) |
| | Mark reviewed · Exclude from reports and budgets |

- **Household-wide rules** in M1; member-scoped rules are #58 (M1.5).
- **Order:** rules run top to bottom; every matching rule applies, and a later one overrides an
  earlier one for the same field. Drag to reorder.
- **Reach (RULE-05):** each action applies only where the rule's creator could do it by hand,
  checked at run time: categorize, rename, and tag on accounts they own or have full access to;
  attribution and exclusion only on accounts they own. A rule never reaches further than its
  author.
- **Manual edits win:** rules run when transactions arrive; they never overwrite a change a
  person made. "Apply to existing transactions" is explicit, with a preview of what would change
  (RULE-06), limited to rows the caller can see.
- **Create from a transaction:** "Always categorize Trader Joe's as Groceries" in the drawer
  creates a rule pre-filled from it.

## 4. Review queue (#44)

- A **Review** view: transactions that need review, oldest first, one at a time with the
  drawer open, or as a list with bulk "Mark reviewed".
- Keyboard: `j`/`k` next and previous, `c` category, `r` mark reviewed and go to the next,
  `e` exclude.
- A **count badge** on Transactions in the navigation when something needs review.
- Reviewer assignment and reminders are #45 (M1.5).

## 5. Transfers (#40)

Moving money between your own accounts isn't income or spending. A transfer is two transactions
linked by `transfer_group_id`, both in the **Transfer** category (left out of cash flow).

- **Detection** runs on import and on manual entry: the other leg is a transaction of the
  **opposite amount**, in the same currency, on **another account**, within **3 days**, not
  already linked.
- **Auto-link only when it's unambiguous and private-safe:** exactly one candidate, and the
  person importing can see both accounts. Otherwise nothing changes automatically.
- **Manual link and unlink** from the drawer. Linking needs ownership of both legs (TXN-08).
- **Across privacy lines** (your checking to a partner's private savings): you see the other
  side as the person, "Transfer to Bea", never the account (F1). Suggesting a link that the
  other owner confirms needs notifications (M4); until then, such pairs stay unlinked.
- Unlinking restores each leg's previous category.

## 6. API

| Route | Who | Notes |
|---|---|---|
| `POST imports/preview` | Owners of the target accounts (TXN-09) | Dry run: counts, per-row status (new, already imported, overlap, error), rules and transfer matches |
| `POST imports` | Same | Creates batches; returns them |
| `GET imports`, `POST imports/:batchId/revert` | Importer or account owner (TXN-10) | |
| `GET`/`POST`/`PATCH`/`DELETE import-profiles` | OWN, MEM | Saved mappings, household-wide |
| `GET`/`POST`/`PATCH`/`DELETE rules`, `PUT rules/order` | RULE-01/03 | |
| `POST rules/:id/preview`, `POST rules/:id/apply` | RULE-06 | Apply to existing, visible rows only |
| `POST transactions/:id/transfer`, `DELETE …/transfer` | TXN-08 | Link to a given transaction, or unlink |

## 7. Decisions to confirm in review
1. **Parse files in the browser** and keep no raw files on the server (§1).
2. **Duplicates skipped, overlaps flagged and left out** unless you tick them (§1).
3. **Monarch:** Monarch's id is the dedupe key; unmatched categories created in a "From Monarch"
   group; rows imported as **reviewed** unless Monarch says "Needs Review"; Owner names become
   attribution; daily balance history imported as entered balances, or values for accounts with
   no transactions (§2).
4. **Rules:** ordered, all matching rules apply, later wins; they never overwrite manual edits (§3).
5. **Transfers:** auto-link only unambiguous pairs the importer can see both sides of (§5).
