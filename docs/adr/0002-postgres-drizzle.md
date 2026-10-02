# ADR 0002: PostgreSQL + Drizzle ORM, money as integer minor units

- Status: Accepted
- Date: 2026-09-30

## Context
Reporting (cash flow, net worth over time, budget vs actual) needs real SQL: window
functions, CTEs, and date bucketing. Money must be exact.

## Decision
- **PostgreSQL 18** is the only supported database. It is the durable state for the whole system.
- **Drizzle ORM** with `drizzle-kit` migrations. The schema lives in TypeScript, and we can
  drop to typed raw SQL for reporting without fighting the ORM.
- Currency amounts are `bigint` minor units plus a `char(3)` currency code. Share
  quantities and prices are `numeric(28,10)`, handled with a decimal library, never JS `number`.
- Migrations run through a dedicated `migrate` command/container. Services never auto-migrate
  on boot in production, because multiple replicas would race each other.

*Revised 2026-10-02 (#9): PostgreSQL 17 → 18 (current major since Sept 2025; adopted before any user data exists).*

## Consequences
- No SQLite "single binary" mode. Self-hosters must run Postgres (included in compose).
- Drizzle is younger than Prisma. We accept that in exchange for SQL control and no engine binary.
