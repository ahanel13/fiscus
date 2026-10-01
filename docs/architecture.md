# Architecture

Fiscus is a self-hosted personal finance platform: account aggregation, flexible
budgeting, bills, goals, investments, receipts, reporting, notifications, and an AI/MCP
interface. It is a **server–client** system: a stateless API is the single source of truth,
and every client (web SPA, MCP server, future mobile app) talks to it over HTTP.

## Design principles

1. **Server owns the data.** Clients never hold the authoritative copy of the ledger. No
   client-side sync engine or CRDTs.
2. **Every service is independently deployable.** Each service ships as its own OCI image,
   is configured only through environment variables, and reaches its peers by URL. The same
   images run in one `docker compose` stack or spread across Proxmox LXCs/VMs.
3. **Providers are pluggable.** Bank aggregation (Plaid, SimpleFIN, file import), market
   data, OCR, LLM, storage, and notification channels sit behind interfaces, so a
   self-hoster can run with no paid third-party services.
4. **Money is exact.** Amounts are stored as `bigint` minor units (cents) together with an
   ISO-4217 currency code. Quantities and prices (shares, crypto) use `numeric(28,10)`.
   Floats are never used for money.
5. **API-first and typed end to end.** Zod schemas in `packages/shared` define request and
   response contracts, and the API publishes OpenAPI generated from them.

## Services

```
                ┌──────────────┐        ┌──────────────┐
  browser ────▶ │  web (SPA)   │        │  mcp server  │ ◀── Claude / LLM clients
                │ nginx static │        │ HTTP + stdio │
                └──────┬───────┘        └──────┬───────┘
                       │ /api (REST, OpenAPI)  │ PAT auth
                       ▼                       ▼
                ┌─────────────────────────────────────┐
                │                 api                 │  NestJS (Fastify adapter)
                │  auth · ledger · budgets · reports  │
                └───────┬──────────────┬──────────────┘
                        │              │ enqueue jobs
                        ▼              ▼
                 ┌────────────┐  ┌───────────┐      ┌────────────────────────┐
                 │ PostgreSQL │  │   Redis   │ ◀──▶ │         worker         │
                 └────────────┘  └───────────┘      │ sync · prices · bills  │
                        ▲                           │ OCR · notify · reports │
                        └───────────────────────────┴───────────┬────────────┘
                                                                │
                         ┌───────────────┐   Plaid / SimpleFIN / market data /
                         │ object store  │   SMTP / ntfy / webhooks / LLM
                         │ (S3 or disk)  │
                         └───────────────┘
```

| Service  | Tech | Scales | Notes |
|----------|------|--------|-------|
| `api`    | NestJS 11 on Fastify, Drizzle ORM | horizontally (stateless) | REST under `/api/v1`, OpenAPI at `/api/docs`, receives Plaid webhooks |
| `worker` | NestJS standalone app + BullMQ | horizontally | All scheduled and async work. Shares domain modules with `api` |
| `web`    | React 19 + Vite + TS, TanStack Query/Router, Tailwind + shadcn/ui, ECharts | static | Served by nginx. API URL is injected at container start |
| `mcp`    | `@modelcontextprotocol/sdk` | optional | Exposes the shared tool registry to external AI clients. Member-bound personal access token ([ADR 0009](adr/0009-ai-assistant-and-mcp.md)) |
| `postgres` | PostgreSQL 17 | — | The only stateful store that matters. Back it up |
| `redis`  | Redis/Valkey 8 | — | Job queues, rate limits, cache. Holds no durable data |
| storage  | S3-compatible (MinIO, Garage, AWS) **or** local disk | — | Receipts and exports |

## Repository layout (pnpm + Turborepo monorepo)

```
apps/
  api/        NestJS HTTP server
  worker/     NestJS background processor
  web/        React SPA
  mcp/        MCP server
packages/
  shared/     zod schemas, DTO types, money utils, enums (used by every app)
  db/         Drizzle schema, migrations, seed
  domain/     business logic shared by api + worker (budget engines, rules, recurrence)
  tools/      AI tool registry used by the in-app assistant and the MCP server
  config/     shared tsconfig / eslint / prettier presets
deploy/
  compose/    docker-compose.yml (all-in-one) + .env.example
  proxmox/    per-service LXC/VM guides and helper scripts
docs/
  adr/        architecture decision records
```

## Domain model (core)

- **Household**: the tenancy boundary. It has members (users) with roles `owner`, `member`, and `viewer`.
- **Ownership, attribution & visibility** ([ADR 0006](adr/0006-shared-finances-yours-mine-ours.md)):
  - accounts are owned by one member (personal) or several (joint, with shares);
  - transactions are attributed to members separately from who paid;
  - accounts are `full`, `balance_only`, or `private` to other members;
  - every view is filtered through a **lens**: me / member / shared / all.
- **Split policy / settlement entry / funding target / allowance**: shared-cost fairness and settle-up between members.
- **Institution / Connection**: a link to a provider (Plaid item, SimpleFIN token, manual).
- **Account**: depository, credit, loan, investment, property, or other. Carries a balance history.
- **Transaction**: amount, date, merchant, category, notes, tags, split children, attachments,
  `pending` state, and `excluded` flag. Provider IDs are kept for dedupe.
- **Category / Category Group**: user-editable. Groups carry a budget "kind"
  (`fixed`, `flexible`, `non_monthly`, `income`, `savings`).
- **Rule**: match conditions → actions (recategorize, rename, tag, split, hide), applied on ingest.
- **Budget**: a period plus a **strategy**, with per-category allocations and rollover settings.
- **Recurring series / Bill**: detected or manual. Tracks expected amount, cadence, and next due date.
- **Goal**: target amount and date. Funded by linked accounts or by budget contributions.
- **Holding / Security / Investment transaction / Price**: positions, lots, cost basis, and performance.
- **Receipt**: an uploaded file with OCR output, matched to a transaction.
- **Notification rule / channel**: event, conditions, and delivery (email, ntfy, Gotify, webhook).

## Budgeting strategies

Budgets are computed by pluggable strategy engines in `packages/domain`:

| Strategy | Behaviour |
|----------|-----------|
| `zero_based` | Envelope style. Every dollar of income is assigned, and "Ready to assign" must reach 0. Overspending pulls from the next month |
| `percentage` | Buckets defined as a percentage of income. 50/30/20 is the default preset, and any custom split is allowed |
| `flex` | Monarch style. Fixed and non-monthly categories are budgeted individually, and discretionary spending gets one flexible number |
| `category` | A classic per-category limit with optional rollover |

Each budget is **scoped** to the household (shared) or to one member (personal), and each chooses its own strategy. A couple can run a shared zero-based budget alongside personal 50/30/20 budgets.

A strategy decides three things: how allocations are defined, how "available" is computed, and how rollover works. The ledger itself is strategy-agnostic, so you can switch strategies without migrating data.

## Cross-cutting concerns

- **Auth**: local accounts (argon2id), httpOnly session cookies for web, personal access
  tokens for MCP and scripts, optional OIDC (Authentik, Keycloak, and so on), and TOTP 2FA.
- **Tenancy & trust** ([ADR 0005](adr/0005-tenancy-and-trust-model.md)): multiple households
  per instance, isolated by app-level scoping plus Postgres RLS. The instance-admin role is
  separate from household roles and never gets financial data from the API. Admin actions
  are audit-logged and visible to household owners. The operator is trusted, and this is
  documented plainly.
- **Secrets at rest**: envelope encryption. A master key from `APP_ENCRYPTION_KEY(_FILE)`
  wraps a per-household data key, which encrypts provider credentials, account numbers,
  notes, and receipts with AES-256-GCM. Deleting a household destroys its key (crypto-shredding).
- **Config**: 12-factor. Env vars are validated with zod at boot, and each service fails fast.
- **AI assistant** ([ADR 0009](adr/0009-ai-assistant-and-mcp.md)): optional, cloud or local
  model. It acts as the member, and every write is a previewable, undoable change set.
- **Plaid** ([ADR 0008](adr/0008-plaid-credentials-and-webhooks.md)): instance keys or
  household-supplied keys. Polling is always on, and webhooks are optional and admin-enabled.
- **Observability**: pino JSON logs, `/healthz` and `/readyz` on every service, and optional
  OpenTelemetry export.
- **Backups**: a documented `pg_dump` plus storage sync, and a `worker` job for scheduled dumps.
