# ADR 0010: Forecasting, retirement & FIRE planning engine

- Status: Accepted
- Date: 2026-10-01

## Context
Monarch's 2026 **Forecasting** (Plus tier) projects net worth and cash flow from real account
data, with life events, side-by-side scenarios, pretax/Roth splits, and early-withdrawal
penalties. We want parity, plus first-class **FIRE** concepts and probabilistic planning,
which Monarch does not market.

Our advantage is that the ledger already knows actual spending, income, savings rate,
recurring bills, and holdings. Planning should start from real data, not a blank questionnaire.

## Decision

### 1. Two horizons, one engine (`packages/domain/forecast`)
| Horizon | Granularity | Purpose |
|---------|-------------|---------|
| **Short-term cash flow** (default 90 days, max 12 months) | Daily, per account | "Will checking dip below $X before payday?" Built from confirmed recurring series, scheduled paychecks, bills/card due dates, and budgeted flexible spending. Feeds low-balance alerts |
| **Long-term plan** (to age 100) | Monthly steps, yearly display | Net worth, retirement readiness, FI date, scenarios |

Both are **pure functions** of (snapshot of current state, assumptions, events) → time series.
They are deterministic and unit-testable, and run in the worker with cached results keyed by
input hash.

### 2. Plan model
- **Plan**: an owner scope (household or member, per ADR 0006 lens), a base snapshot (live
  balances or frozen), and assumptions:
  - inflation;
  - per-asset-class returns and volatility;
  - salary growth;
  - spending baseline (trailing 12-month actual by default, overridable);
  - tax settings.
- **Members in a plan**: birth year, retirement age, life expectancy, Social Security (PIA
  entered from the SSA statement, plus claim age), and employment income. Couples get
  per-member ages and retirement dates.
- **Account treatment**: taxable, traditional (401k/403b/457b/IRA), Roth, HSA, pension/annuity,
  cash, real estate, debt. A single account can hold **mixed pretax and Roth** balances.
  Contributions include employer match and annual limits (a versioned data table).
- **Life events**: one-time or **repeating at an interval** (e.g. a car every 6 years);
  windfalls; home purchase (down payment, mortgage, **PMI**, property tax, appreciation);
  child; career break; job change; healthcare before Medicare; custom.
- **Scenarios**: copy-on-write variants of a plan, compared **side by side** (net worth, FI
  date, success probability, year-by-year diff).
- **Display**: nominal ↔ real ("today's dollars") toggle everywhere.

### 3. Retirement mechanics
- A configurable **withdrawal order** (default taxable → traditional → Roth, or a custom
  per-account schedule) and per-account withdrawal start dates.
- **Early withdrawal penalty** (10%) with exceptions modeled explicitly: Rule of 55, 72(t)/SEPP,
  Roth contribution basis, and a **Roth conversion ladder** with the 5-year seasoning rule.
- **RMDs** from the RMD age onward.
- **Taxes, simplified:** federal ordinary and LTCG brackets plus standard deduction (a
  versioned yearly data table), a flat state rate, and Social Security taxation. Penalties and
  taxes appear as their own cash-flow lines.
- **Social Security**: claim-age adjustment to the entered PIA, with an optional haircut assumption.

### 4. FIRE
- **FI number** = annual retirement spending ÷ safe withdrawal rate (default 4%, configurable).
  Spending defaults to the trailing 12-month actual from the ledger (lens-aware: household or
  personal).
- **Variants:** Lean / regular / Fat FI (spending presets), **Coast FI** (amount needed now to
  reach FI by retirement age with zero further contributions), and **Barista FI** (part-time
  income covering the gap).
- **Metrics:** savings rate (monthly trend, from the ledger), years to FI, FI date, % to FI, and
  the "crossover point" chart (passive income ≥ expenses).
- **Withdrawal strategies:** constant-dollar SWR, constant percentage, **guardrails**
  (Guyton-Klinger), and VPW.

### 5. Uncertainty
- **Deterministic** projection by default (matches Monarch's UX).
- **Monte Carlo** (e.g. 1 000–10 000 paths, seeded, lognormal returns with correlation) gives
  success probability and percentile bands.
- **Historical backtest** (cFIREsim/FIRECalc style) runs every historical start year using the
  public Shiller US stock/bond/CPI dataset, which is bundled as data.

### 6. Scope limits (explicit)
- **US tax rules first.** The engine isolates tax and retirement-account rules behind a
  `Jurisdiction` interface so other countries can be contributed later.
- This is **education and planning, not financial advice**, and the UI says so.

### 7. AI integration
Forecast tools are added to the ADR 0009 registry: run a scenario, compare scenarios, explain a
result ("why did my FI date move?"), and propose an event or assumption change (as a change set).

## Consequences
- This adds a sizeable, math-heavy domain module. It gets golden-file tests against
  hand-checked spreadsheets and property tests (e.g. zero-return plans conserve money).
- The yearly tax and contribution-limit tables need a maintenance process (one data PR per year).
- It depends on investments (holdings and asset classes) and recurring/bills for good inputs, so it sits after those milestones.
