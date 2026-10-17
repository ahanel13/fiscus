# Transfers: review, and the other side in manual accounts (M1 Phase 4 follow-up)

- Status: Proposed
- Builds on: [imports §5](imports.md) (transfers, #40, #317), [rules](imports.md) (#41), permissions TXN-02, TXN-08, RULE-05

Cash flow already leaves transfers out by **category**, linked or not. What it can't see is the
opposite mistake: something filed as a transfer that **isn't one** (a Venmo to a friend, a payment
to someone else's card, money that never arrived). It drops out of spending without a trace. This
phase makes those visible, links the transfers that detection left alone, and lets a transfer to
an account the bank feed can't reach (a credit-union loan, a 401(k)) record its other side there.

This is a **reconciliation**: it makes sure every transfer accounts for both sides, so the
financial picture is accurate and nothing falls through the cracks. The Transfers view opens with
that explanation in plain words, since it's not something most finance apps show.

## 1. Matching across bank timing

Detection runs on whichever side arrives second (an import now, each bank sync in M2), so a slow
transfer still links when it lands. What matters is the window: a Friday ACH between banks can post
the next Tuesday or Wednesday.

- **Identical transfers in step** (round-ups: two $0.75 out of checking and two into a vault the
  same day) aren't ambiguous: any pairing is right. When the possible matches form a block with one
  kind of transaction on each side, as many each way, each matching every one opposite, they're
  paired in order, on arrival and by the review's "Link the clear pairs". Anything less clean
  (three and two) is left for a person.
- The window becomes **3 business days** (weekends don't count; holidays aren't known yet), so
  Friday → Wednesday matches. Auto-linking stays as strict as before otherwise: exactly one
  candidate from both sides, both accounts yours (imports §5).

## 2. Transfer review

A **Transfers** section on the Review page, worked out when you open it (no background job):

| List | What's in it | You can |
|---|---|---|
| **Suggested pairs** | A transfer-category or uncategorized row with possible other sides that detection didn't link: two candidates, or 4–10 days apart | **Link** one; **Link all** the pairs with exactly one candidate each |
| **No other side** | A row in a transfer category, not linked, **more than 7 days old** (younger ones may be in transit), with no candidate | **Link** to a transaction you pick; **The other account isn't in Fiscus** (stops asking); **Recategorize** it (it was spending) |

- This is also how history imported before detection existed gets linked: its pairs appear as
  suggestions, and **Link all** links them in one go. No re-import.
- Only rows in accounts you own are listed (linking needs ownership of both sides, TXN-08); "isn't
  in Fiscus" and recategorizing need categorize access (owner or full).
- The count of both lists joins the review badge.
- **Grouped** (#332): suggestions by account pair ("SoFi Checking → House: 12") and rows with no
  other side by account, the biggest group first, so a large import reads as a few groups. A
  group's **Link N** links its clear pairs and the likely ones, after you
  confirm; pairs with a real choice stay for you. Each link says how many other pairs it settled,
  and its message offers **Undo**, which unlinks everything it linked, settled pairs too.
- **Likely** means a hint points to one candidate: the names ("From Holiday Vault"), or else the
  closest date both ways. A recurring transfer ($10 to investing every few days) has several
  same-amount candidates in range, but each one's other side is the deposit nearest to it, which
  is nearest to it in turn. A tie gives no hint.

## 3. "Transfer to an account" (a rule action)

A rule can say a matching transaction is a transfer to one of your accounts, and how long its other
side may take. It's an ordinary rule, so you choose the conditions, the account, and the window:

> When the description contains "MOHELA" and money goes out → **transfer to Student loan, within
> 7 days; if it isn't there, record it**.

When the rule matches a transaction as it arrives:

1. **The other side is there** (the opposite amount in that account, up to N days before or after,
   not linked): the nearest one is linked. Two equally near are left for you in the transfer review.
2. **It isn't there, and "record it" is on:** a transaction is created in that account with the
   opposite amount, the same date and name, and linked. For an account the bank feed doesn't cover
   (a credit-union loan, a 401(k)): its balance follows. Only a manual account that follows its
   transactions can take one; one whose balance is entered by hand is refused (its transactions
   don't move its balance).
3. **Otherwise it waits:** the transaction is marked as expecting its other side in that account
   for N days, and moves to Transfer meanwhile (unless a person chose its category), so it isn't
   counted as spending. Whatever lands in that account within the window, in any category, links
   to it, whichever arrives first. The transfer review doesn't ask about it until the window has
   passed.

- **N** is 1–31 days (default 5), chosen in the rule. It replaces the usual 3 business days for the
  transactions the rule matches.
- **Reach (RULE-05):** the rule's author must own **both** accounts, checked when it's saved and
  when it runs, as for linking by hand (TXN-08) and adding transactions (TXN-02). The person
  importing must own both too, since linking writes both sides.
- **Never twice:** a transaction already linked is left alone, so re-imports and re-runs don't
  duplicate anything.
- **Undo:** a transaction it records belongs to the import that brought the first side: undoing the
  import removes both. Deleting either side unlinks the other, as for any transfer.
- **"Apply to existing"** links and waits, but **never records**: it would create history in an
  account that may already have its own (a Monarch export's balances). Its preview says what each
  transaction would get.

## 4. Data

- `transactions.transfer_external boolean` (default false): the other side is in an account outside
  Fiscus. Set from the review; a person's decision (recorded in `field_versions`).
- `transactions.transfer_expected_account_id`, `transfer_expected_days`: a rule is waiting for this
  transaction's other side there (§3). Cleared when it's linked.
- Recorded transactions: `source = manual`, in Transfer, reviewed, with the `import_batch_id` of the
  import that brought the first side, so undo includes them.

## 5. API

| Route | Who | Notes |
|---|---|---|
| `GET transactions/transfer-review` | Any member who can categorize | `{ suggested, unmatched, counts }`, rows you can see in accounts you own or have full access to. Each row carries only what the list shows (name, date, amount, account, category, version); opening one loads the rest |
| `POST transactions/transfer-review/link-all` | Owners of both sides (TXN-08) | Links every suggested pair with exactly one candidate each, as shown |
| `PATCH transactions/:id` `{ transferExternal }` | Categorize access (TXN-04) | "The other account isn't in Fiscus" |
| `GET transactions/review-count` | Any member | Now `{ count, transactions, transfers }` |
| Rules: action `transferTo: { accountId, withinDays, recordIfMissing }` | RULE-03, reach RULE-05 | Refused when saved for an account you don't own (`invalid_account`), or "record" into one that can't take it (`cannot_record`) |

## 6. Decisions to confirm in review

1. **Business-day window** (3 business days) for auto-linking; suggestions up to 10 days (§1, §2).
2. **"No other side" waits 7 days** before asking (§2).
3. **The review is computed on the fly**, not a job; the badge counts it too (§2).
4. **"Transfer to an account"** links within the rule's days (default 5), waits for the other side
   meanwhile, and records it only on arrival, only into a manual account that follows its
   transactions, in the same currency; the author must own both accounts (§3).
