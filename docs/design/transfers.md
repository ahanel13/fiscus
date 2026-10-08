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

## 3. "Record the other side" (a rule action)

For an account the bank feed doesn't cover, a rule creates the matching transaction in it when the
transfer arrives in a connected (or imported) account:

> When the description contains "MOHELA" and money goes out → **record the other side in Student
> loan**.

- **What it creates:** a transaction in the chosen account with the **opposite amount**, the same
  date, the same name, in Transfer, **linked** to the arriving one as a transfer. Its balance
  follows (a manual account that follows its transactions).
- **Which accounts:** manual accounts only (no bank connection), in the same currency. An account
  that's *valued* (balance entered by hand) is refused: its transactions don't move its balance.
- **Reach (RULE-05):** the rule's author must own **both** accounts, checked when it runs, as for
  linking by hand (TXN-08) and adding transactions (TXN-02).
- **Once:** never for a row already linked as a transfer, so re-imports and re-runs don't duplicate.
- **Undo:** created during an import, it belongs to that import: undoing the import removes it too.
  Deleting either side unlinks the other, as for any transfer; the created one stays until you
  delete it.
- **On arrival only** (imports now, bank sync in M2). "Apply to existing" skips this action: it
  would create history in an account that may already have its own (a Monarch export's balances).
  The preview says so.

## 4. Data

- `transactions.transfer_external boolean` (default false): the other side is in an account outside
  Fiscus. Set from the review; a person's decision (recorded in `field_versions`).
- Created transactions: `source = manual`, `import_batch_id` of the import that triggered them, so
  undo includes them.

## 5. API

| Route | Who | Notes |
|---|---|---|
| `GET transactions/transfer-review` | Any member who can categorize | `{ suggested, unmatched }`, rows you can see in accounts you own or have full access to |
| `POST transactions/transfer-review/link-all` | Owners of both sides (TXN-08) | Links every suggested pair with exactly one candidate each, as shown |
| `PATCH transactions/:id` `{ transferExternal }` | Categorize access (TXN-04) | "The other account isn't in Fiscus" |
| `GET transactions/review-count` | Any member | Now `{ count, transactions, transfers }` |
| Rules: action `recordOtherSide: { accountId }` | RULE-03, reach RULE-05 | Validated against the target when saved and when run |

## 6. Decisions to confirm in review

1. **Business-day window** (3 business days) for auto-linking; suggestions up to 10 days (§1, §2).
2. **"No other side" waits 7 days** before asking (§2).
3. **The review is computed on the fly**, not a job; the badge counts it too (§2).
4. **Record the other side** only into manual, transaction-following accounts in the same currency,
   only on arrival, and the author must own both accounts (§3).
