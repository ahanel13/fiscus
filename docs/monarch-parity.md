# Monarch feature parity

Compared against Monarch's publicly announced features as of October 2026: the Winter 2026
release, the August/September 2026 updates, and Forecasting on the Plus tier.

**Legend:**
- ✅ planned at parity
- ➕ planned beyond Monarch
- 🟡 partial / different approach
- ⛔ intentionally out of scope

Milestones refer to [roadmap.md](roadmap.md).

## Accounts & aggregation
| Monarch | Fiscus | Status | Where |
|---|---|---|---|
| Plaid / MX / Finicity aggregation, switch per institution | Plaid + SimpleFIN + file import. MX/Finicity need business contracts | 🟡 | M2 |
| Manual accounts, CSV import, Mint import | Manual, CSV/OFX/QFX, **Monarch import** (P1), YNAB/Actual (Mint shut down in 2024) | ✅ | M1 |
| Real-time refresh with per-account status | Refresh now, connection health panel, polling + optional webhooks | ✅ | M2 (ADR 0008) |
| Account groups, ordering, account notes | Planned | ✅ | M1 (P2) |
| Zillow home value, vehicle value | Manual value + appreciation curve, pluggable valuation provider (Zillow's API is closed) | 🟡 | M6 |
| Coinbase / crypto | Exchange read-only keys or public wallet addresses | ✅ | M6 (P2) |
| Equity compensation (RSU/ISO/NSO/RSA, vesting) | Planned. AI document extraction later via receipt pipeline | ✅ | M6 |
| Apple Card / Apple Cash (iOS FinanceKit) | Needs a native iOS app | ⛔ | Apple Card CSV export via file import |
| Own Plaid keys per household | Instance key or household-supplied key | ➕ | M2 |

## Transactions
| Monarch | Fiscus | Status | Where |
|---|---|---|---|
| Categories, groups, tags, notes, splits, search, bulk edit | Planned | ✅ | M1 |
| Rules (rename, recategorize, tag, hide, split, link goal) | Rules engine; goal-link action | ✅ | M1, M5 |
| Needs-review flow, review reminders | Review queue, assign reviewer, reminders | ✅ | M1 |
| Transaction activity log | Per-transaction history on the audit log | ✅ | M1 |
| Pending edits persist on post | Planned | ✅ | M1 |
| Amazon / Target order sync (Chrome extension) | Order-history import (Amazon data export, retailer CSV), auto-split; extension later | 🟡 | M2 (P2) |
| Business tracking | Business flag + business reports | ✅ | M1 (P3) |
| Venmo/PayPal enrichment | Statement import enrichment | ➕ | M2 (P2) |

## Budgeting
| Monarch | Fiscus | Status | Where |
|---|---|---|---|
| Category budgets with rollover | Category strategy | ✅ | M3 |
| Flex budgeting (fixed / flexible / non-monthly) | Flex strategy | ✅ | M3 |
| Monthly + annual views | Planned | ✅ | M3 |
| Budget ↔ goals integration | Goal contributions as budget lines | ✅ | M3/M5 |
| Zero-based / envelope | Strategy | ➕ | M3 |
| Percentage (50/30/20 or custom) | Strategy | ➕ | M3 |
| Separate + shared budgets with different strategies | Budget scope | ➕ | M3 (ADR 0006) |

## Household / couples
| Monarch | Fiscus | Status | Where |
|---|---|---|---|
| Invite partner, shared access | Members and roles | ✅ | M0 |
| Mine / theirs / ours ownership, owner filters, shared views | Ownership, attribution, lens across all views | ✅ | M1 (ADR 0006) |
| Profile colors, household details (ZIP, dependents, employment) | Member profile; details feed AI + planning | ✅ | M1, M8 |
| Account privacy between partners (balance-only / private) | Three visibility levels | ➕ | M1 |
| Split policies, settle-up ledger, funding targets, allowances | Planned | ➕ | M3 |
| Financial advisor access | Viewer role covers the in-household case; a cross-household advisor role is not planned | 🟡 | — |
| Multiple unrelated households on one server | Multi-tenant instance | ➕ | M0 (ADR 0005) |

## Recurring & bills
| Monarch | Fiscus | Status | Where |
|---|---|---|---|
| Recurring detection, calendar, upcoming | Planned | ✅ | M4 |
| Credit card statement due dates | From Plaid liabilities | ✅ | M4 |
| Subscription insights | Subscription audit + price-increase detection | ✅ | M4 |

## Goals
| Monarch | Fiscus | Status | Where |
|---|---|---|---|
| Save Up goals with status (on track / ahead / at risk) | Planned | ✅ | M5 |
| Pay Down goals, avalanche vs snowball | Planned | ✅ | M5 |
| Multi-account funding, spend from goals, transaction linking + rules | Planned | ✅ | M5 |
| Investment growth rate on goals | Planned | ✅ | M5 (P2) |
| Per-partner contributions to shared goals | Planned | ➕ | M5 |

## Investments
| Monarch | Fiscus | Status | Where |
|---|---|---|---|
| Holdings, performance, gains/losses | Planned (TWR, cost basis, lots) | ✅ | M6 |
| Allocation treemap (asset class, sector), custom class overrides | Planned | ✅ | M6 |
| Benchmark comparison | Planned | ✅ | M6 (P2) |
| Diversification insights | Planned | ✅ | M6 |
| Morningstar fund analysis | Free-source fund data only (licensing) | 🟡 | M6 (P2) |

## Forecasting & retirement
| Monarch | Fiscus | Status | Where |
|---|---|---|---|
| Net worth projection from real data, adjustable assumptions | Planned | ✅ | M8 (ADR 0010) |
| Life events, repeating-interval events, windfalls, PMI | Planned | ✅ | M8 |
| Side-by-side scenarios | Planned | ✅ | M8 |
| Real vs future dollars, growth-rate controls | Planned | ✅ | M8 |
| Mixed pretax/Roth, withdrawal order, early-withdrawal penalties | Planned, plus Rule of 55, 72(t), Roth ladder, RMDs | ➕ | M8 |
| Short-term (90-day) daily cash-flow / overdraft forecast | Planned | ➕ | M8 |
| FIRE: FI number, Coast/Barista/Lean/Fat FI, crossover, savings rate | Planned | ➕ | M8 |
| Monte Carlo + historical backtests, guardrails/VPW withdrawal strategies | Planned | ➕ | M8 |
| Requires paid Plus tier | Included | ➕ | — |

## Reports & dashboard
| Monarch | Fiscus | Status | Where |
|---|---|---|---|
| Cash flow, spending/income breakdowns, stacked bars | Planned | ✅ | M7 |
| Sankey | Planned | ✅ | M7 |
| Treemap with drill-down | Planned | ✅ | M7 |
| Ownership grouping in reports | Lens | ✅ | M7 |
| Filter-aware exports | CSV/XLSX/PDF | ✅ | M7 |
| Dashboard widgets | Customizable per member | ✅ | M7 (P2) |
| Saved custom reports, scheduled report emails | Planned | ➕ | M7 (P2) |

## Time ranges & history
| Monarch | Fiscus | Status | Where |
|---|---|---|---|
| Date presets (this/last month, last N months, YTD, last year, all time, custom) | Shared `DateRangeSpec`, plus rolling last 7/30/90 days and quarters | ✅ | M1 (ADR 0011) |
| Net worth range chips | Same chips on every balance/performance chart | ✅ | M1 |
| Monthly / quarterly / yearly toggle in reports | Granularity toggle, auto-picked | ✅ | M1 |
| Averages skip empty months | Planned, plus partial-period marking | ✅ | M1 |
| Period comparison (vs previous / last year) | Compare toggle everywhere | ➕ | M1 |
| Fiscal year start, custom budget month start day | Household settings | ➕ | M1 |

## Receipts
| Monarch | Fiscus | Status | Where |
|---|---|---|---|
| Photo upload, email forwarding, bulk upload | Planned (email-in via IMAP) | ✅ | M9 |
| Auto-match to transactions, line-item split | Planned | ✅ | M9 |
| Forwarding failure alerts | Notification rule | ✅ | M4/M9 |
| Per-line attribution feeding settle-up; local OCR/AI option | Planned | ➕ | M9 |

## AI
| Monarch | Fiscus | Status | Where |
|---|---|---|---|
| AI assistant (Q&A on your finances) | In-app assistant | ✅ | M10 (ADR 0009) |
| Contextual insights, weekly recap | Statistical insights (no LLM needed) + recap email | ✅ | M4 |
| Assistant can *act* (rules, recategorize, budgets) via reviewable, undoable change sets | Planned | ➕ | M10 |
| Choice of cloud or local model, MCP access for external AI clients | Planned | ➕ | M10 |

## Platform & security
| Monarch | Fiscus | Status | Where |
|---|---|---|---|
| iOS/Android apps, widgets, shortcuts | Responsive web only | ⛔ | Decision: web-only |
| MFA | TOTP + OIDC | ✅ | M0 |
| SOC 2 | N/A for self-hosted; envelope encryption, RLS, audit log | 🟡 | ADR 0005 |
| Self-hosted, open source (AGPL), no subscription | — | ➕ | ADR 0007 |
| Notification channels | Email + ntfy/Gotify/webhooks | ➕ | M4 |

## Known gaps we are accepting
- **Native mobile apps, widgets, and Apple Card FinanceKit sync** (web-only decision).
- **MX/Finicity aggregators** (commercial contracts); **Morningstar data** (licensing); **Zillow API** (closed).
- **Live Amazon/Target sync** starts as file import. A browser extension is P3.
- A **cross-household financial advisor role** is not planned.
