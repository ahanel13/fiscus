# ADR 0006: Shared finances: ownership, attribution, visibility, and lenses ("yours / mine / ours")

- Status: Accepted (revised 2026-10-01: logic fixes F1–F6; added `view_only` level in #3 review)
- Date: 2026-09-30

## Context
Combining finances with a partner is a headline feature, not an add-on. Couples (and more
generally N-member households such as roommates or a parent with an adult child) need to:

- keep some money separate, some shared, and some private;
- budget separately *and* together, possibly with different strategies;
- split shared costs fairly (50/50, by income, per category) and settle up;
- fund joint accounts and allowances by agreement.

Retrofitting this later would touch every table, query, report, and screen, so it is part of
the core model from M0.

## Decision

### 1. Members
A household has **N members** (`household_members`: display name, color, avatar, role). The UI
is tuned for two, e.g. "Mine / Alex's / Ours", but nothing assumes exactly two.

**Naming.** This is the "his / hers / ours" (a.k.a. "yours / mine / ours") model. UI labels
are **viewer-relative** and name-based, never gendered: *Mine* · *[member name]'s* · *Ours*.
The same account reads "Mine" to its owner and "Alex's" to a partner.

### 2. Ownership (accounts)
- `account_owners(account_id, member_id, share_bps)`, with shares in basis points summing to 10 000.
  - One owner → **personal** ("mine"/"yours").
  - Multiple owners → **joint** ("ours"). The default is an equal split. Custom shares are
    allowed, e.g. a 70/30 split of a joint brokerage account for net worth.
- An aggregation connection (Plaid Item, SimpleFIN) is owned by the member who linked it.
  Its accounts default to that member and can be reassigned.

### 3. Attribution (transactions)
- **Who pays** (the account) and **who it's for** (attribution) are separate concepts.
- `transaction_attributions(transaction_id, member_id, share_bps)`. If absent, attribution
  inherits from the account's owners. Split children can carry their own attribution.
- Example: groceries bought on a personal card, attributed "ours". This drives settle-up (§7)
  and makes the purchase appear in shared spending.
- **Attributing a transaction to another member shares that transaction with them**, even if
  the source account is private. *(F1)* They see the transaction and **who paid** ("paid by
  Anthony"), **never the account**. No account name, mask, or "private account" placeholder
  appears, so the existence of a private account is not revealed.
- **Editing attribution** *(F6)*: any owner of the paying account may set or change attribution.
  Changes that move money between members (anything affecting settle-up) are written to the
  household **activity feed**. An affected member can **flag** the change, which marks it
  disputed in the settle-up view until the payer resolves it. There is no approval workflow,
  but no change is silent either.

### 4. Visibility (privacy within the household)
Per account, set by its owners:

| Level | Other members see |
|-------|-------------------|
| `full` | Account, balances, transactions, and they can **categorize/review** them (category, rename, tags, review status, shared note) |
| `view_only` | Account, balances, and transactions, **read-only**. Private notes and attribution flags only |
| `balance_only` | Account name/type, balance history, and its contribution to net worth. No transactions |
| `private` | Nothing. Excluded from their views and from household totals they see |

- *(F2)* Owners always see their own accounts, so `private` means "hidden from non-owners".
  On a **joint account in a two-member household**, `private` is meaningless and is not offered.
  With three or more members, a joint account can be `private` to its owners.
- *(F3)* Because visibility differs per member, **household totals differ per viewer**. Every
  aggregate is labeled as such, e.g. "Net worth (visible to you)". Hidden accounts are never
  hinted at ("+2 hidden"), since that would leak their existence. A member who wants their money
  in shared totals without exposing activity uses `balance_only`; that is its purpose.
- This is enforced in **Postgres RLS** at member granularity. The API and worker set
  `app.member_id` alongside `app.household_id` (ADR 0005). It extends to derived data:
  receipts, notes, rules scoped to that account, and search.
- The household `owner` role manages membership and settings but **cannot override** another
  member's `private`, `balance_only`, or `view_only` accounts.
- Background jobs run as the system, but anything they surface (notifications, digests, MCP
  answers) is filtered for the *recipient* member.
- As with the operator (ADR 0005), privacy between members is enforced by permissions, not cryptography.

### 5. Lens
- Every read endpoint accepts `lens`:
  - `me`
  - `member:<id>`
  - `shared` (joint accounts plus "ours" attributions)
  - `all` (everything *visible to the caller*)
- The effective data set is *visible to caller* ∩ *lens*.
- *(F6)* Lenses mean different things for money and for spending:

  | View type | Driven by | `me` means | `shared` means |
  |-----------|-----------|------------|----------------|
  | **Money**: balances, net worth, account lists, funding | **Ownership** | My personal accounts + my ownership share of joint accounts | Joint accounts |
  | **Spending**: budgets, spending/cash-flow reports, bills, settle-up | **Attribution** | Transactions attributed solely to me | Transactions attributed to ≥2 members |

  `member:<id>` mirrors `me` for another member, limited to what the caller can see.
- A global lens switcher sits in the web shell. The dashboard, budgets, reports, net worth,
  bills, goals, and MCP all honor it.
- Single-member households hide the switcher entirely.

### 6. Scoped budgets, goals, bills
- `budgets.scope`: `household` (shared) or `member:<id>` (personal). Each budget picks its own
  strategy (ADR/architecture: zero-based, percentage, flex, category), e.g. a shared zero-based
  budget for household costs plus each partner's personal 50/30/20 budget.
- Goals have the same scope, and shared goals track **per-member contributions**.
- Bills and recurring series have a **responsible member**, who gets the reminders.
- Categories are household-wide. Rules may be household-wide or member-scoped.

### 7. Shared-cost features (all in v1)
1. **Contribution split rules**: `split_policies(household_id, category_id?, method, params,
   effective_from)`. Methods:
   - `equal`
   - `income_proportional`: declared income, or a trailing 3-month attributed income.
     *(F4)* A proportional split inherently reveals relative income, so it requires **every
     affected member to opt in**, choosing either a *declared* figure or *actual* income from
     their accounts. The UI states that the resulting ratio will be visible to the others.
     Until everyone opts in, the policy stays inactive and the split falls back to the
     household default.
   - `fixed_percent`
   - `fixed_amount`

   A household default applies, with per-category overrides, e.g. rent by income and groceries 50/50.
2. **Who-owes-whom ledger**: for each shared expense, compare what each member *paid* (account
   ownership) with what they *owe* (split policy × attribution). The difference goes into
   `settlement_entries`, recomputed idempotently when transactions change. A running balance
   is kept per member pair. Transfers between members' accounts can be marked, or
   auto-detected, as **settlements**. Manual adjustments are allowed.
3. **Joint-account funding targets**: `funding_targets(account_id, member_id, method: percent_of_income | fixed, amount, cadence)`.
   Inbound transfers from each member's accounts are matched against the target: on track, behind, or ahead.
4. **Allowances / fun money**: a shared-budget line that funds a member's personal budget each
   period. Other members see the **allocation amount only**. The budget never itemizes how it
   was spent. Rollover is configurable.
   *(F5)* This hides spending only within **budget views**. Transactions on a **joint**
   account stay visible to its co-owners, wherever the money came from. For real privacy, the
   allowance is paid into a **personal** account, which can be modeled as a funding target, and
   spent from there. The UI says this when an allowance is set up.

### 8. Finance style presets (added in #3 review)
Not every couple splits costs. Many fully combine their finances. The model already handles
that: if every account is **joint**, every purchase is "ours", both members are owners with full
edit rights, and settle-up is always $0. The household **finance style** turns that into a
first-class experience. It is chosen at onboarding and can be changed any time.

| Style | New-account defaults | Screens |
|---|---|---|
| **Combined** ("it's all ours") | Joint for all members, `full` | Settle-up, split policies, and the lens switcher hidden. One shared budget. Allowances still available |
| **Hybrid** (yours / mine / ours) | Owned by the linking member, `full` | Everything shown |
| **Separate** (split shared costs) | Owned by the linking member, `view_only` | Settle-up and split policies prominent |

- Presets set **defaults and visibility of features only**. They never rewrite existing data.
  Switching to Combined offers a one-click "make all accounts joint", and switching away changes nothing until the members edit ownership.
- Each hidden feature can be re-enabled individually (a per-household feature toggle overrides the preset).
- Single-member households have no style and see none of these screens.

### 9. Member lifecycle
- Invite/join is covered in ADR 0005. **Leaving / separating** (P2) is a guided flow:
  - solely owned accounts leave with the member;
  - joint accounts are assigned or duplicated;
  - settlement balances are finalized;
  - the leaving member can export their data first.

## Consequences
- Every financial query goes through a `VisibilityScope` built from (member, lens). Tests
  must cover cross-member leakage the same way ADR 0005 tests cover cross-household leakage.
- Aggregates must be computed per caller, not cached household-wide. Report caches key on
  (household, member, lens, params).
- Transfers between a visible and a private account reveal only the visible side. The
  counterpart shows as the **member** ("Transfer to Anthony"), never as an account (F1).
- Shared-math leakage is inherent and disclosed, not prevented: income ratios (F4), joint-account
  activity (F5), and attributed purchases (F1).
- The worker must handle member-targeted notifications and filtering.
- There is more schema up front: `account_owners`, `transaction_attributions`,
  `split_policies`, `settlement_entries`, `funding_targets`, and budget/goal scopes. This is
  far cheaper now than as a migration later.
