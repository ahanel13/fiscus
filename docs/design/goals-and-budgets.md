# Goals and budgets: where they meet (design, M3 and M5)

Budgets are being finished in M3 (zero-based #100, 50/30/20 #101) before goals exist (M5, #131).
They touch in several places, and the budget engine is the harder one to change later. This
settles how they fit, so M3 builds what M5 needs and nothing has to be rebuilt.

It builds on the [budgeting walkthrough](walkthroughs/budgeting.md) (decisions D1–D26) and
[ADR 0006](../adr/0006-shared-finances-yours-mine-ours.md). Decisions here are numbered **G1**,
**G2**, …, and collected [at the end](#decisions). Monarch is the reference, as it is for
budgets: goals are funded by accounts, and the budget has a line for each goal's monthly
contribution.

---

## 1. Two kinds of money set aside

The budget already saves up: a **non-monthly category** sets aside a twelfth of its yearly figure
each month, and spending draws on it (D12). Travel at $3,600 a year shows "$300.00 a month" and a
**Saved** balance. A goal ("Japan trip, $6,000 by next May") looks like the same thing. They
aren't, and mixing them up is how the same dollars get counted twice.

**G1. A budget's saved money is a plan; a goal's is money in accounts.**
- A non-monthly category's Saved balance is **in the budget only**: what's been set aside on
  paper. The money can sit anywhere, usually checking. It's for costs that come round every year.
- A goal's progress is **money in accounts** (G2): it's only as real as the balances behind it.
  It's for something you're saving toward once, or building up (an emergency fund, a house).
- A goal is never a category, and a category is never a goal. The budget shows a goal as its own
  kind of line (G4), not in a category group.
- Creating a goal whose name matches a non-monthly category says so: "Travel already saves
  $300.00 a month in your budget. Keep both, or stop saving there?" Nothing changes without an
  answer.

---

## 2. What a goal is made of

**G2. A goal draws on one or more accounts, each by a claim.**
- A claim is part of an account's balance earmarked for the goal: **a fixed amount** ("$8,000 of
  Savings") or **a percentage** ("40% of Brokerage"). A percentage grows and falls with the
  balance, which suits investments (#140). A fixed amount stays put.
- A goal can draw on several accounts (a house fund from savings and a brokerage account): its
  progress is the claims added up. An account can back several goals: $8,000 for the house and
  $2,000 for the trip, out of $20,000, leaves $10,000 unclaimed.
- Unclaimed money is just money in the account. It isn't offered to the budget.
- Claims are the many-to-many funding of #138, and progress (#135) and status (#137) come from
  them.

**G3. Claims never quietly exceed the balance.**
- Setting up or raising claims beyond what an account holds is refused: "Savings has $1,200.00
  unclaimed."
- When a balance later falls below its claims (spending, a market drop), the account and every
  goal it backs show **Short $3,000.00**, and nothing is moved. You choose which goal gives
  way. Goal priority (#136) only suggests ("Trip is lower priority: take it from there?").
- A percentage claim can't be short on its own. Fixed claims on the same account are filled
  first, and percentages share what's left.

---

## 3. A goal in the budget

**G4. A goal's monthly contribution is a budget line, in every strategy.**
- A goal with a target date suggests a monthly amount ("$450.00 a month to make May"). Putting it
  in a budget adds a **goal line**: "Japan trip · $450.00 planned".
- The line's **moved** figure is what reached the goal this month: transfers into the accounts it
  draws on, and raises of its fixed claims that follow them (G11). A transfer that lands in an
  account backing two goals is split by their claims, or put toward one (G13).
- Transfers are otherwise never counted in a budget (D1). This is the one exception, and only on
  the goal line, so nothing is counted twice.
- A goal can be in the Ours budget or in a Mine budget, following its scope (G7), and is never in
  both.

**G5. How each strategy treats a goal line.**

| Strategy | The goal line |
|---|---|
| Category limits | Planned against moved, with a bar. Not spending: it never makes the budget "over". No rollover |
| Flex | A fixed line beside the fixed costs, outside the flexible number |
| Zero-based | Assigning to it takes from **Ready to assign**, like any category. What's assigned but not yet moved stays on the line as **to move** and rolls over, as envelopes do (D9). Moving it clears it |
| 50/30/20 | Counted in the **Savings** bucket. The bucket already counts transfers into savings and investment accounts (D10); a transfer that's also a goal's is counted once, and labeled with the goal |

- Switching strategies keeps goal lines and their amounts, as it keeps everything (D14).
- Money already in an account backing a goal never enters Ready to assign (D8 counts only what
  arrives). Your savings aren't up for assigning every month.

**G6. Spending from a goal isn't overspending.**
- A purchase linked to a goal (#139), by hand or by a rule ("Link to goal"), is **paid from the
  goal**. The flights for the Japan trip lower the trip's claim by their amount.
- In the budget it still shows in its category, so nothing goes missing (D6), marked **from
  Japan trip**. It doesn't count against the category's limit, the flexible number, Ready to
  assign or a bucket.
- When the goal can't cover it (claims smaller than the purchase), the rest counts as ordinary
  spending, and the line says how much.

---

## 4. Shared goals, private accounts

**G7. Goals have a scope, as budgets do, and claims show only themselves.**
- A goal is **Ours** or **Mine** (ADR 0006 §6). A Mine goal, like a Mine budget, is visible only
  to you (D3).
- An Ours goal can draw on a member's private account. The others see the claim, "Alex's savings:
  $8,000.00 toward this", and never the account's balance or transactions (ADR 0006 §4).
- Each member's **contributions** to a shared goal (#133) are the changes in claims on their own
  accounts, plus their share of claims on joint accounts by ownership. Shared costs read the same
  figures, as they read contributions (D2).
- Only an account's owners can claim it for a goal. A claim on a joint account needs one owner,
  and the others are told, as other shared changes are.

**G8. When the household changes, claims follow the accounts.**
- A member who leaves (ADR 0012) takes their private accounts, and their claims on shared goals
  end the day they leave. The goals show the shortfall (G3); history up to then stays.
- An account that's closed, disconnected or made private to someone else ends its claims the
  same way, with a notice to the goal's members.

---

## 5. Debt payoff goals

**G9. A payoff goal is a goal on a loan or card's balance, and its extra payments are its line.**
- The target is the liability's balance reaching zero (#134), and progress is how far it's come
  down. Snowball and avalanche order several of them.
- Payments are transfers (D7). The **required** payment is a bill (M4). The **extra** payment is
  the goal line: planned against what was paid over the minimum. Neither counts as spending.

---

## 6. Month boundaries

**G10. A goal's months are its budget's months.** Monthly amounts, moved figures and "on track"
use the budget month, including a mid-month start day once there is one (#71). A goal in no
budget uses calendar months.

---

## 7. What M3 built, and M5 added

Goal lines are built (#132): each goal's plan is its line in its scope's budget in every strategy,
from `goal_plans` (G16), and its moved figure is worked out from transfers (G4, G13) or extra paid
on a debt (G9). Still to come: putting a transfer toward one goal of two (G13's choice), and Move
money and Cover with goal lines (zero-based).


Nothing on goals' screens. Just enough that M5 adds goals without changing the budget engine:
- **The budget engine (built in #98) learns line kinds.** A budget line is a category or a goal. The goal kind is
  defined, with no goals yet to point at, so Ready to assign, rollover and the Savings bucket
  already handle it (G4, G5).
- **#100 (zero-based):** Ready to assign, rollover and Cover treat a goal line as an envelope
  whose spending is "moved" (G5). Move money and Cover can take from or give to a goal line's
  to-move balance, never from the goal's claims.
- **#101 (50/30/20):** the Savings bucket counts a transfer once, whether or not a goal claims it
  (G5).
- **Every strategy:** spending marked "paid from a goal" is shown but not counted (G6). Until
  #139 nothing is marked, but the rule lives in one place.
- **#102's non-monthly categories** stay as they are (G1).

## 8. The finer points

**G11. Earmarking money already there is progress, not saving.** Claiming $5,000 already in
savings counts toward the goal's progress, but not toward this month's moved figure or anyone's
contributions: it isn't new money. A raise that follows a transfer into the account in the same
month does count, up to the transfer.

**G12. A market fall is the market's.** A percentage claim on a brokerage account can fall below
where it was. The goal shows the change as **market**, apart from contributions, and a fall never
reads as a missed month. "On track" projects with the expected growth rate (#140).

**G13. One transfer into an account backing two goals is split by their claims.** The default
needs no question; the transfer's drawer shows the split and lets you put it all toward one goal.

**G14. Only savings goals take purchases.** There's no money in a debt to spend, so payoff goals
(G9) can't be linked to purchases (G6).

---

## Decisions

| # | Decision | Shapes |
|---|---|---|
| G1 | A non-monthly category's Saved is a plan in the budget; a goal is money in accounts; never the same thing | #102, #132 |
| G2 | A goal draws on accounts by claims: a fixed amount or a percentage; many-to-many | #132, #135, #138, #140 |
| G3 | Claims can't be set beyond the balance; a later shortfall is shown, and you choose which goal gives way | #136, #137, #138 |
| G4 | A goal's monthly contribution is a budget line, measured by what moved; the one place transfers count | #98, #100, #101, #102 |
| G5 | Each strategy treats goal lines its own way; zero-based rolls over what's not yet moved | #98, #100, #101, #104 |
| G6 | Purchases paid from a goal show in their category but don't count against the budget | #98, #103, #139 |
| G7 | Goals are Ours or Mine; claims on private accounts show only the claim | #133, #113 |
| G8 | Claims end when a member leaves or an account closes, and the shortfall shows | #257, ADR 0012 |
| G9 | Payoff goals' extra payments are their budget line; required payments are bills | #134 |
| G10 | A goal's months are its budget's months | #71 |
| G11 | Earmarking money already in an account is progress, not this month's saving or a contribution | #132, #133, #135 |
| G12 | A market fall shows as the market's, never as a missed contribution | #137, #140 |
| G13 | A transfer into an account backing two goals is split by their claims, and can be put toward one | #138 |
| G14 | Only savings goals take purchases | #134, #139 |
