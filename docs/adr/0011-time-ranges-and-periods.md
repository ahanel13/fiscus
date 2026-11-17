# ADR 0011: One time-range model for every view

- Status: Accepted
- Date: 2026-10-01

## Context
Viewing history by period ("last 30 days", "this month", "YTD", "quarterly") is one of the most
used interactions in a finance app. Monarch's version is intuitive because it is **consistent**:
the same presets, chips, and granularity toggles appear on the dashboard, reports, net worth,
investments, and transactions. If each screen invents its own date filter, the app feels
inconsistent and numbers don't line up.

## Decision

### 1. A shared `DateRangeSpec` (in `packages/shared`)
A range is stored as **intent**, not resolved dates, so saved reports, dashboards, links, and AI
requests stay relative ("YTD" is still YTD next month).

```ts
type DateRangeSpec =
  | { kind: 'preset'; preset: Preset }
  | { kind: 'custom'; from: ISODate; to: ISODate };

type Preset =
  | 'this_month' | 'last_month'
  | 'last_7d' | 'last_30d' | 'last_90d'
  | 'this_quarter' | 'last_quarter'
  | 'last_3m' | 'last_6m' | 'last_12m'          // whole calendar months, incl. current
  | 'ytd' | 'this_year' | 'last_year'
  | 'all_time';

type Granularity = 'day' | 'week' | 'month' | 'quarter' | 'year';
type Comparison  = 'none' | 'previous_period' | 'same_period_last_year';
```

- **Rolling** presets (`last_30d`) count days back from today. **Calendar** presets (`this_month`,
  `last_3m`, `this_quarter`) snap to period boundaries. The UI groups them separately so the
  difference is obvious.
- The server resolves a spec to concrete dates using the **household's timezone** and settings
  (§4). The API accepts `range`, `granularity`, and `compare` on every time-based endpoint and
  returns the resolved `from`/`to` alongside the data, so the UI never re-derives dates.

### 2. Consistent UI patterns
| Pattern | Used on | Behaviour |
|---------|---------|-----------|
| **Range chips** `1M · 3M · 6M · YTD · 1Y · All` | Net worth, account balance charts, investments performance, goals | One click, highlights the active chip |
| **Range dropdown** (grouped presets + custom calendar) | Reports, cash flow, transactions, dashboard widgets, receipts | Shows the resolved dates under the label ("Last 30 days · Sep 1 – Sep 30") |
| **Granularity toggle** `Monthly · Quarterly · Yearly` (+ Weekly/Daily for short ranges) | Cash flow, spending/income reports, savings rate | Auto-picked from range length, overridable. Invalid combinations are disabled |
| **Period stepper** `‹ September 2026 ›` | Budget, recaps, cash-flow detail, settle-up statement | Steps by the current granularity; "Today" jumps back |
| **Compare toggle** | Reports, dashboard summary cards | Previous period or same period last year, shown as deltas and ghost series |

### 3. Correctness rules
- **Partial periods** (the current month/quarter) are visually marked (hatched bar, "so far"
  label) and excluded from averages by default.
- **Averages skip periods with no data** (e.g. before an account was linked) rather than counting them as zero.
- **Date basis**: transactions use the posted date by default. A household setting can switch to the authorized/transaction date.
- **Balances** for a range use end-of-day snapshots, and charts plot the last snapshot per bucket.
- Every range-aware query goes through one `resolveRange()` helper, which is unit-tested for
  edge cases: month ends, leap years, DST, quarter boundaries, and fiscal-year offsets.

### 4. Household and member settings
- Household: **timezone**, **week start** (Sun/Mon), **fiscal year start month** (affects YTD
  and quarters; default January).
- Member: **default range per page** (e.g. reports open on "Last 6 months, Monthly").
- Household: **budget month start day** (#71, budgeting D32), e.g. the 15th for mid-month
  paydays. Default 1, the calendar month. It changes the months of budget views only: the
  budget, its annual view, allowances, filling a month (last month's amounts and the 3-month
  average), goal lines, the weekly recap's budgets, the "nearly spent" notification, and a newer
  member's first budget month under the history window (#256). Reports, cash flow, the range
  presets, shared costs' statements and joint-account funding targets keep calendar months: a
  funding target is a commitment between owners, not a budget, and its weeks don't follow the
  budget either.
  - A budget month is **named for the month it starts in**: with the 15th, "November" runs from
    Nov 15 to Dec 14.
  - A start day a month doesn't have (29–31) falls on **its last day**: with the 31st,
    February's month starts on the 28th (29th in a leap year) and runs to Mar 30. Months never
    overlap or leave a gap.
  - It's a calendar date in the household's time zone, like every other boundary here, so
    daylight saving never moves it.
  - `budgetMonthStart()`, `budgetMonthOf()` and `budgetMonthRange()` in `packages/shared` work
    them out, beside `resolveRange()`, and are tested for the same edge cases. In SQL,
    `budgetMonthSql()` (`packages/ledger`) buckets dates the same way, and
    `fiscus_budget_window()` (0109) finds the history window's budget month.

### 5. State and sharing
- The current range/granularity/compare are in the **URL query string**, so views are bookmarkable and shareable within the household.
- The last-used selection per page is remembered per member (server-side preference, so it follows them across devices).
- An optional "sync range across pages" toggle per member.

### 6. AI
The ADR 0009 tools accept the same `DateRangeSpec`. The assistant maps natural language ("last
quarter", "since we moved in") to presets or custom ranges and echoes the resolved dates in its answer.

## Consequences
- One component set, one resolver, one API contract. Adding a preset is a single change everywhere.
- Every time-based endpoint must accept the spec; this is enforced by a shared zod schema and API tests.
