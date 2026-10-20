# Roadmap & initial backlog (DRAFT, planning phase)

Milestones run in order. Each epic becomes a `type:epic` issue, and each bullet becomes an
issue, filed once this plan is approved. `[P0]`–`[P3]` = priority.

---

## M0 · Foundation
**Epic: Foundational design** (`area:docs`)
- [P0] Design: core data model ERD for M0–M1 (households, members, accounts + owners, transactions + attributions, categories, rules, keys, audit) with money types and RLS columns
- [P0] Design: permissions matrix (instance admin / owner / member / viewer / PAT scopes × visibility levels × actions), the source for the leakage test suites
- [P0] Design: API conventions (resource naming, cursor pagination, RFC 9457 errors, lens/range params, idempotency keys, versioning, auth)

**Epic: Repo, tooling & infrastructure** (`area:infra`)
- [P0] Monorepo scaffold: pnpm + Turborepo, `apps/{api,worker,web,mcp}`, `packages/{shared,db,domain,config}`
- [P0] CI: lint, typecheck, unit tests, build, and docker build on every PR
- [P0] Per-service Dockerfiles (multi-stage, non-root, multi-arch) plus `/healthz` and `/readyz`
- [P0] `docker-compose.yml` (all-in-one) and `docker-compose.dev.yml` (Postgres, Redis, Mailpit, MinIO)
- [P1] Zod-validated env config package, with fail-fast startup errors
- [P1] Drizzle setup, migration runner container, dev seed data (fake household)
- [P1] Release workflow: SemVer tag → GHCR images and GitHub Release
- [P2] Branch protection, Renovate/Dependabot, CodeQL
- [P1] License hygiene: SPDX headers, DCO check on PRs, dependency license check in CI ([ADR 0007](adr/0007-license-agpl.md))

**Epic: Auth, tenancy & security** (`area:auth`), see [ADR 0005](adr/0005-tenancy-and-trust-model.md)
- [P0] Local signup/login (argon2id), session cookies, CSRF protection
- [P0] Households, memberships, and roles (owner/member/viewer). Users can belong to multiple households
- [P0] Household scoping: request-scoped `HouseholdContext`, scoped repository helpers, a cross-tenant leak test suite
- [P0] Postgres Row-Level Security policies on all household tables (`app.household_id` set per transaction), plus a separate migration/admin DB role
- [P0] Member-level RLS (`app.member_id`) for account visibility, see [ADR 0006](adr/0006-shared-finances-yours-mine-ours.md)
- [P0] `CryptoService` + `KeyProvider`: master key from env/file, per-household wrapped data keys, AES-256-GCM
- [P1] Instance-admin role and admin console: users, households, invites, signup mode (open/invite-only/closed), provider config. Metadata only, no financial data
- [P1] Append-only audit log, with an owner-visible "activity affecting your household" view
- [P1] Household deletion with crypto-shredding (destroy the data key) and a data export beforehand
- [P2] Key rotation: re-wrap data keys under a new master key, plus a background data-key re-encryption job
- [P1] Personal access tokens (for MCP and scripts), with scopes and revocation
- [P2] TOTP 2FA
- [P2] OIDC login (Authentik/Keycloak/Authelia)

**Epic: Web app shell** (`area:web`)
- [P0] Vite/React shell: routing, auth pages, layout, nav, dark mode
- [P1] Typed API client generated from the OpenAPI spec, with TanStack Query conventions
- [P1] Design system baseline (Tailwind + React Aria Components), money/date formatting components
- [P1] Responsive layout: usable in a phone browser (transaction review, quick categorize, receipt upload via camera). No native app

## M1 · Core ledger
**Epic: Accounts & transactions** (`area:ledger`)
- [P0] Accounts CRUD (manual accounts, all types), balance history table
- [P0] Transactions CRUD, filtering, search, pagination, bulk edit
- [P0] Categories and category groups (with budget "kind"), plus a default category set
- [P1] Transaction splits
- [P1] Tags and notes
- [P1] Transfers: detection and linking between accounts (excluded from spending)
- [P1] Rules engine: conditions → actions, applied on ingest, with a "create rule from this transaction" option
- [P1] Merchant name cleanup/normalization
- [P0] Review workflow: "needs review" state on new transactions, mark reviewed (individually or in bulk), review queue
- [P1] Edits to pending transactions carry over when they post (category, tags, notes, review state, attribution)

**Epic: Shared finances core: yours / mine / ours** (`area:shared`), see [ADR 0006](adr/0006-shared-finances-yours-mine-ours.md)
- [P0] Household members model: display name, color, avatar. N members, UI tuned for 2
- [P1] Finance style presets (Combined / Hybrid / Separate) at onboarding: new-account defaults, show/hide shared-cost screens, per-feature overrides, one-click "make all joint"
- [P0] Account ownership (`account_owners` with shares). Personal vs joint, with reassignment
- [P0] Account visibility (full / view-only / balance-only / private), enforced by RLS and extended to receipts, notes, rules, and search
- [P0] Transaction attribution (who it's for vs who paid), with inheritance from the account, per-split attribution, and "attributing shares it" semantics
- [P0] `VisibilityScope` + `lens` param (me / member / shared / all) on every read endpoint
- [P0] Cross-member leakage test suite (private and balance-only accounts, transfers, aggregates)
- [P1] Global lens switcher in the web shell, hidden for single-member households
- [P0] Shared purchases show the payer, never the account; transfers show the counterpart member (ADR 0006 F1)
- [P1] "Visible to you" labeling on all aggregates; `private` not offered on joint accounts in two-member households (F2, F3)

**Epic: Time ranges & period navigation** (`area:web`), see [ADR 0011](adr/0011-time-ranges-and-periods.md)
- [P0] `DateRangeSpec` / `Granularity` / `Comparison` zod schemas, plus the server-side `resolveRange()` with household timezone and an edge-case test suite
- [P0] API convention: `range`, `granularity`, `compare` on every time-based endpoint, which echoes the resolved dates
- [P0] UI components: range chips (1M·3M·6M·YTD·1Y·All), grouped range dropdown with custom calendar, granularity toggle, period stepper, compare toggle
- [P0] Partial-period marking, and averages that skip empty periods
- [P1] URL-synced state, plus a per-member remembered default per page (server preference)
- [P1] Household settings: timezone, week start, fiscal year start month, posted vs transaction date basis

**Epic: File import** (`area:aggregation`)
- [P0] CSV import with column mapping, saved mapping profiles, and a dedupe preview
- [P1] **Import from Monarch** (transactions, accounts, categories, tags, balance history), for a smooth migration

## M1.5 · Ledger polish
Ledger features a usable first version doesn't need, split from M1 so M1 ends at a usable app.
Triaged in October 2026: what M2 builds on moved there, and the rest went to the milestone it
belongs to, or to the backlog.

**Epic: File import** (`area:aggregation`)
- [P1] OFX/QFX import (#74, done)

**Polish** (`area:ledger`, `area:web`, `area:auth`)
- [P1] The browser checks that the server's activity history extends what it last verified (ADR 0013 §4, #264)
- [P2] Account groups and custom ordering; account notes (#48, done)
- [P3] Rule editor: start simple, add conditions as needed (#355)
- [P3] A test for session expiry: 7 days idle, 30 days absolute (#379)

## M2 · Bank aggregation
**Epic: Plaid integration** (`area:aggregation`)
- [P0] `AggregationProvider` interface and connection model (encrypted credentials)
- [P0] Plaid Link flow (link token, public token exchange), with institution and account mapping
- [P0] `/transactions/sync` cursor-based incremental sync worker job
- [P0] Scheduled polling sync (default 4 h, admin-configurable) plus "refresh now", and re-auth via update mode. See [ADR 0008](adr/0008-plaid-credentials-and-webhooks.md)
- [P0] Instance-default Plaid credentials (env / `_FILE` secrets). Each Item records its credential set
- [P1] Household-supplied Plaid keys (encrypted with the household key, write-only secret), with an admin toggle and a guided re-link when switching credential sets
- [P1] Optional webhooks, enabled by the admin via public base URL: `POST /api/v1/webhooks/plaid`, JWT verification per credential set, enqueue-only handlers, `/item/webhook/update` migration, and relaxed polling while healthy
- [P2] Webhook health panel in the admin console, plus a proxy/tunnel guide exposing only the webhook path
- [P1] Balances and liabilities refresh
- [P1] Investments: holdings and investment transactions
- [P1] Pending → posted transaction reconciliation
- [P2] Connection health dashboard and error surfacing
**Epic: SimpleFIN (free alternative)**
- [P2] SimpleFIN Bridge provider

**Epic: Retail order enrichment** (`area:aggregation`)
- [P2] Amazon order history import (from Amazon's "Request your data" export), matched to card transactions and auto-split by item (reuses the receipt split engine)
- [P2] Target / Walmart / Costco order CSV and PDF import using the same matcher
- [P2] Venmo / PayPal / Cash App statement import to enrich "VENMO *" transactions with counterparty and memo
- [P3] Browser extension for live order sync

**From the ledger, for synced transactions** (`area:ledger`, `area:shared`)
- [P1] Transaction edit history (per-transaction activity log, built on the audit log) (#46)
- [P1] Member-scoped rules (#58)

## M3 · Budgeting
**Epic: Flexible budgeting** (`area:budget`)
- [P0] Budget model: period, strategy, allocations, rollover. Strategy engine interface in `packages/domain`
- [P0] Strategy: category limits with rollover
- [P0] Strategy: zero-based/envelope ("Ready to assign", overspend handling, moving money between categories)
- [P0] Strategy: percentage buckets (50/30/20 preset, custom splits, based on actual or expected income)
- [P1] Strategy: flex (fixed, non-monthly, and one flexible number)
- [P1] Budget UI: month view, budget vs actual, progress bars, quick-assign
- [P1] Switch strategy without data loss, with a preview of the effect
- [P2] Budget templates and "copy last month" / "use 3-month average"
- [P1] Annual budget view and yearly totals per category
- [P2] Budget month start day (mid-month pay cycles) (#71)
- [P0] Budget scope: shared (household) or personal (member), each with its own strategy

**Epic: Couples & shared costs** (`area:shared`), see [ADR 0006](adr/0006-shared-finances-yours-mine-ours.md) §7
- [P0] Split policies: equal / income-proportional / fixed % / fixed amount, with a household default and per-category overrides and an effective-from date
- [P0] Income basis for proportional splits: declared income or trailing 3-month attributed income, with **per-member opt-in consent**. The policy stays inactive until all affected members consent (F4)
- [P0] Who-owes-whom ledger: `settlement_entries` computed from paid vs owed, recomputed idempotently, with a per-pair running balance
- [P0] Settlement transfers: mark or auto-detect transfers between members as settle-ups, plus manual adjustments
- [P1] Joint-account funding targets (percent of income or fixed per cadence), with on-track / behind / ahead tracking
- [P1] Allowances / fun money: a shared budget line funds a personal budget. Others see the allocation only, with a setup notice that joint-account spending stays visible (F5)
- [P1] "Ours" overview page: shared spending, split fairness, balances owed, funding status
- [P2] Settle-up reminders and monthly settlement summary notification
- [P1] Attribution activity feed with "flag change", plus a disputed state in settle-up (F6, #60)
- [P2] Consent requests with a 14-day expiry and an archive fallback (ADR 0012, #265). Departures as a whole: [ADR 0012](adr/0012-member-lifecycle.md)

## M4 · Bills, recurring & notifications
**Epic: Bill & recurring tracking** (`area:bills`)
- [P0] Recurring series model (cadence, expected amount, variance tolerance)
- [P0] Auto-detection of recurring transactions from history, with confirm/dismiss
- [P1] Bills calendar and upcoming list, with paid/unpaid matching
- [P1] Responsible member per bill. Reminders go to that member
- [P1] Credit card statement due dates (from Plaid liabilities)
- [P2] Subscription audit view (price increases, unused subscriptions)
- [P1] Assign a reviewer (e.g., a partner reviews shared-card transactions), plus review reminder notifications (#45)

**Epic: Notifications** (`area:notifications`)
- [P0] `NotificationChannel` interface, SMTP email channel, templated emails (MJML/React Email)
- [P1] ntfy, Gotify, and generic webhook channels
- [P1] Notification rules: bill due, large transaction, low balance, budget threshold, sync failure
- [P1] Weekly recap (dashboard card + email): spending vs budget, notable transactions, net worth change, upcoming bills
- [P1] Contextual insights without an LLM: unusual spending (z-score per category/merchant), new subscriptions, price increases, net worth swings
- [P2] In-app notification center

## M5 · Goals
**Epic: Goal tracking** (`area:goals`)
- [P0] Goals CRUD: savings target, target date, linked accounts or budget contributions
- [P0] Goal scope (shared / personal), with per-member contribution tracking on shared goals
- [P1] Debt payoff goals (snowball/avalanche projection)
- [P1] Progress tracking and "on track" projection chart
- [P2] Goal priority and automatic allocation suggestions
- [P1] Goal status: on track / ahead / at risk, from contribution pace and completion-date projection
- [P1] Many-to-many funding (one goal from several accounts, one account backing several goals with earmarked amounts)
- [P1] Link transactions to goals (manually, in bulk, and via rule action), and spend from a goal (spending reduces its balance)
- [P2] Expected growth rate for investment-backed goals

## M6 · Investments
**Epic: Investment tracking** (`area:investments`)
- [P0] Securities, holdings, lots, investment transactions (buy/sell/dividend/split)
- [P0] `PriceProvider` interface and a daily price refresh job
- [P1] Performance: time-weighted return, gains/losses, cost basis, dividends
- [P1] Allocation breakdown (asset class, sector, account, taxable vs tax-advantaged)
- [P2] Manual holdings / crypto / real estate (with manual valuation)
- [P2] Benchmark comparison (e.g., vs S&P 500)
- [P1] Asset-class overrides per security, and diversification insights (concentration, single-stock exposure)
- [P1] Equity compensation: RSUs, ISOs, NSOs, RSAs with grants, vesting schedules, vested/unvested value, and upcoming vests
- [P2] Fund details from free sources (expense ratio, holdings overlap); no licensed Morningstar data
- [P2] Crypto exchange/wallet balances (read-only API keys or public addresses)
- [P2] Property and vehicle valuation: manual value plus appreciation/depreciation curve, with an optional pluggable valuation provider

## M7 · Reporting & dashboards
**Epic: Reports & graphs** (`area:reports`)
- [P0] Dashboard: net worth, cash flow, budget summary, upcoming bills, recent transactions
- [P0] All reports and the dashboard honor the lens. Net worth is shown per member, joint, and combined (respecting ownership shares and visibility)
- [P0] Net worth over time (daily snapshots job)
- [P0] Cash flow report (income vs expense, by month, drill-down)
- [P1] Spending by category/merchant/tag over any range, with period comparison
- [P1] Sankey income → spending flow
- [P1] Treemap for spending/income (group → category → merchant → transactions drill-down)
- [P2] Customizable dashboard widgets (add, remove, reorder per member)
- [P1] Export: CSV/XLSX/PDF
- [P2] Custom saved reports
- [P2] Scheduled report emails
- [P1] Multi-currency: daily FX rates (`FxRateProvider`), read-time conversion to the household base currency, original foreign amounts on converted purchases. Accounts and transactions already store their currency (#43)

## M8 · Forecasting, retirement & FIRE
**Epic: Planning engine** (`area:planning`), see [ADR 0010](adr/0010-forecasting-retirement-fire.md)
- [P0] Short-term cash-flow forecast: daily per-account balances for 90 days from recurring series, paychecks, bills, and budgeted flexible spending. Feeds low-balance alerts
- [P0] Plan model: scope (household/member), base snapshot, assumptions (inflation, returns, salary growth, trailing-12-month spending baseline)
- [P0] Members in a plan: birth year, retirement age, life expectancy, income, Social Security PIA + claim age
- [P2] Household members without logins (e.g. children/dependents) for planning and attribution. The schema already allows this (data model §3.1)
- [P0] Account tax treatment (taxable/traditional/Roth/HSA/pension/cash/property/debt), mixed pretax+Roth balances, contributions, employer match, IRS limit tables
- [P0] Deterministic long-term projection engine (monthly steps), with nominal vs real toggle and cash-flow table drill-in
- [P0] Life events: one-time, repeating interval, windfall, home purchase (mortgage + PMI + taxes + appreciation), child, career break, job change, pre-Medicare healthcare
- [P1] Scenarios: copy-on-write variants, side-by-side comparison (net worth, FI date, success %, year-by-year diff)
- [P1] Withdrawal modeling: order, per-account start dates, 10% early-withdrawal penalty with Rule of 55, 72(t), Roth basis, Roth conversion ladder, and RMDs
- [P1] Simplified taxes: federal brackets + LTCG + standard deduction (versioned tables), flat state rate, Social Security taxation
- [P1] Golden-file test suite against hand-checked spreadsheets, plus property tests

**Epic: FIRE** (`area:planning`)
- [P0] FI number from actual trailing spending ÷ SWR (configurable). % to FI, years to FI, FI date (lens-aware)
- [P0] Savings rate trend from the ledger
- [P1] Lean / regular / Fat FI presets, Coast FI, Barista FI
- [P1] Crossover chart (passive income vs expenses)
- [P1] Withdrawal strategies: constant-dollar SWR, constant %, guardrails (Guyton-Klinger), VPW
- [P1] Monte Carlo (seeded, correlated lognormal returns) with success probability and percentile bands
- [P2] Historical backtest over every start year (bundled Shiller dataset)
- [P2] Forecast tools in the AI registry: run/compare scenarios, explain FI date changes, propose events (change sets)
- [P3] `Jurisdiction` plug-ins for non-US tax/retirement rules

## M9 · Receipts
**Epic: Smart receipts: AI extraction, matching & line-item splits** (`area:receipts`, `area:ai`)
- [P0] `LlmProvider` interface (Anthropic, OpenAI-compatible/Ollama), with per-household config, usage logging, and structured-output helpers
- [P0] `ObjectStorage` interface (local disk and S3), upload endpoint (web + phone camera), image/PDF viewer, receipts encrypted with the household key
- [P0] Attach receipts to transactions manually
- [P0] `ReceiptExtractor` interface returning structured JSON (merchant, date, card last 4, subtotal, tax, tip, total, line items). Implementations: vision LLM via `LlmProvider` (Claude, or Ollama with a local VL model), with a Tesseract + LLM fallback
- [P0] Matching engine: scores candidates on amount (with tip tolerance), date window, merchant similarity, and card last 4 → account. Auto-attaches above a threshold, otherwise sends to a review queue. Runs in both directions (receipt → transactions, new transaction → unmatched receipts)
- [P0] Line-item classification into household categories, using the category list and past corrections as context
- [P0] Split proposal: group by category, spread tax/discounts/tip proportionally, largest-remainder rounding so it equals the posted amount to the cent. Review and confirm UI
- [P1] Per-line attribution (mine / partner / ours), feeding settle-up (ADR 0006)
- [P1] Correction memory per household (merchant + item → category/attribution), applied before calling the LLM
- [P1] Per-merchant auto-apply ("always split Costco receipts"), and provenance plus one-click revert for every AI action
- [P1] Per-household AI provider setting (cloud / local / off), with a clear disclosure when images leave the server
- [P2] Email-in receipts (IMAP poller), plus a bulk upload / watch folder
- [P2] Local lightweight item classifier (embeddings + kNN on confirmed items) to cut LLM calls
- [P2] Extraction accuracy harness: labeled sample receipts, run in CI against each extractor

## M10 · AI assistant & MCP
**Epic: AI assistant & MCP on a shared tool layer** (`area:ai`), see [ADR 0009](adr/0009-ai-assistant-and-mcp.md)
- [P0] `packages/tools` registry: zod schemas, permission scope, read/write kind, handlers on domain services
- [P0] Instance/household/member AI settings (providers, model, on/off, write tools allowed, cloud disclosure acknowledgement), plus a tool-calling capability check for local models
- [P0] Read tools: transactions search/aggregate, accounts, budgets, bills, goals, net worth, reports, settle-up, receipts. All honor visibility + lens
- [P0] Change-set engine: write tools produce previewable diffs, then apply atomically with one-click undo and an audit entry `via: assistant`
- [P0] Write tools: recategorize, rename, tag, note, split, attribution, rules (with dry run), budget allocations, goals/bills, recurring confirm, receipt match
- [P0] In-app assistant: chat panel in the web shell, server-side agent loop via `LlmProvider`, streaming, change-set review cards
- [P0] MCP server (streamable HTTP and stdio) on the same registry, member-bound PAT with `read`/`write` scopes, and an `apply_change_set` tool
- [P1] Conversation storage encrypted with the household key, retention setting (default 90 days), member can view/delete
- [P1] Usage logging and per-household token budgets (soft/hard limits)
- [P1] Prompt-injection test suite (adversarial merchant names, memos, receipts)
- [P1] Insight prompts: monthly review, "where did my money go", over-budget explainer, subscription audit, rule suggestions from corrections
- [P2] Opt-in auto-apply for low-risk single-transaction changes
- [P2] AI categorization suggestions inline in the transactions list

## M11 · Community release (v1.0)
**Epic: Deployment & docs** (`area:docs`, `area:infra`)
- [P0] Install guide: docker compose quick start
- [P0] Proxmox guide: per-service LXCs (Postgres, Redis, app), including a MinIO/Garage setup for receipts
- [P0] Backup and restore (scheduled `pg_dump` job and storage sync), with a documented restore drill
- [P1] Reverse proxy examples (Caddy, Traefik, Nginx Proxy Manager)
- [P1] Plaid setup guide (developer account, production access, webhooks via a public URL or tunnel)
- [P2] Helm chart / Proxmox helper scripts
- [P2] Import from YNAB / Actual exports, for people switching apps (#76)

---

## Backlog (no milestone)
- [P2] "Sync range across pages" member toggle (#70)
- [P3] Business tracking: mark accounts/transactions as business, with business-only reports (Schedule C-friendly export) (#49)

---

## Resolved decisions
- **Tenancy & trust:** multi-household instances with a trusted operator, per-household envelope encryption, RLS, and an audit log. See [ADR 0005](adr/0005-tenancy-and-trust-model.md).
- **Clients:** web app only, responsive for phone browsers. No native mobile app, and no PWA/offline mode.
- **Shared finances:** N-member households with account ownership, transaction attribution, three visibility levels, a lens across all views, and all four shared-cost features in v1. See [ADR 0006](adr/0006-shared-finances-yours-mine-ours.md).
- **License:** AGPL-3.0-or-later, with DCO and no CLA. See [ADR 0007](adr/0007-license-agpl.md).
- **Plaid:** instance-default keys, households may supply their own, polling always on, webhooks optional and admin-enabled. See [ADR 0008](adr/0008-plaid-credentials-and-webhooks.md).
- **Planning:** forecasting, retirement, and FIRE engine, US rules first. See [ADR 0010](adr/0010-forecasting-retirement-fire.md).
- **Member lifecycle:** joining with a history window, privacy within the household, claiming a dependent profile, and fair departures (departure package, protection mode, statement) for families, couples, and roommates alike. See [ADR 0012](adr/0012-member-lifecycle.md).
- **Verifiable confidentiality:** the server keeps computing (sync, rules, notifications) with no feature given up; encrypted volumes and backups and verifiable signed releases for everyone; and for a hosted service, confidential VMs whose keys only published code can get, so operators can't read data. See [ADR 0014](adr/0014-verifiable-confidentiality.md).
- **Activity history:** every change recorded (encrypted before/after), no silent deletes, and a per-household hash chain with outside witnesses, so tampering, even by the operator, is detectable. See [ADR 0013](adr/0013-tamper-evident-activity-history.md).
- **Time ranges:** one shared date-range model with presets, chips, granularity, period stepper, and comparison, used by every view. See [ADR 0011](adr/0011-time-ranges-and-periods.md).
- **AI:** optional in-app assistant plus MCP on one tool layer, cloud or local models, writes via reviewable change sets. See [ADR 0009](adr/0009-ai-assistant-and-mcp.md).

## Open questions (to resolve before filing)
_None. The `gh` token now has the `project` scope._
