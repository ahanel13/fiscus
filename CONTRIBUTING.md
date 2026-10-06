# Contributing / Development workflow

This project runs as a lightweight SDLC on GitHub: **Epic → Issue → Branch → PR → Release**.

## Work items

| Type | Label | Purpose |
|------|-------|---------|
| Epic | `type:epic` | A feature area (e.g. Budgeting). Tracks child issues as sub-issues / task list |
| Feature | `type:feature` | A user-visible capability, sized to land in 1 PR (≤ ~2 days) |
| Chore | `type:chore` | Tooling, infra, refactors, deps |
| Bug | `type:bug` | Defect against released or merged behaviour |
| Spike | `type:spike` | Time-boxed research; output is an ADR or a comment, not code |

Every issue has: an `area:*` label, a `priority:*` label, a milestone, and **acceptance criteria**.

**Priorities:** `P0` blocks a milestone · `P1` required for milestone · `P2` nice to have · `P3` someday.

**Milestones** are the roadmap phases in [docs/roadmap.md](docs/roadmap.md).

## Branches & commits

- `main` is always releasable and protected; no direct pushes.
- Branch name: `<type>/<issue#>-<short-slug>` — e.g. `feat/12-plaid-link`, `fix/40-rollover-rounding`.
- Every commit is signed off (`git commit -s`) per the [DCO](https://developercertificate.org/): you certify you have the right to contribute it under the project's license, AGPL-3.0-or-later ([ADR 0007](docs/adr/0007-license-agpl.md)). The **DCO** check fails a PR with an unsigned commit; fix it with `git rebase --signoff origin/main && git push --force-with-lease`. Bot commits (Renovate) are exempt and reviewed instead.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(budget): add zero-based strategy engine (#31)`.
  Scopes = app or package names (`api`, `web`, `worker`, `mcp`, `db`, `shared`, `domain`) or areas.

## Pull requests

- One PR closes one issue (`Closes #N`). Keep PRs small; split if > ~600 changed lines (excluding generated code / lockfile).
- Fill in the PR template. CI must be green before merging. Required checks:
  - **CI / Lint, typecheck, test, build**: format check, lint, typecheck, unit tests, build
  - **PR title / Conventional Commit title**
  - **CI / Docker image (api, worker, mcp, web)**: each image builds

  GitHub only *enforces* required checks on Pro or public repos (#13). Until then, treat them as required by convention.
- Squash-merge; PR title becomes the commit, so it must be a Conventional Commit.
- DB schema changes include a migration **and** are called out in the PR.

## Definition of Done

- [ ] Acceptance criteria met
- [ ] Unit tests for domain logic; integration test for new API endpoints
- [ ] Types/schemas in `packages/shared` updated; OpenAPI regenerates
- [ ] Migrations included and reversible where practical
- [ ] Every write to household data records activity in the same transaction, and user deletes are tombstones ([ADR 0013](docs/adr/0013-tamper-evident-activity-history.md))
- [ ] New household-scoped tables follow [ADR 0012](docs/adr/0012-member-lifecycle.md): `household_id` on every row, no cross-household references, and covered by the move-out job
- [ ] Docs updated (README, `.env.example`, ADR if an architectural decision was made)
- [ ] No secrets, tokens, or real financial data committed

## Releases

SemVer tags `vX.Y.Z` on `main` trigger image builds to GHCR and a GitHub Release with
generated notes. Pre-1.0, minor bumps may contain breaking changes (called out in notes).

## Local development

Requires Node 26 (`.nvmrc`), pnpm (via corepack), and Docker.

```bash
npm install -g corepack   # Node 25+ no longer bundles corepack
corepack enable           # provides the pnpm version pinned in package.json
pnpm install
pnpm build        # build all packages and apps
pnpm dev          # api :3000, web :5173, worker, mcp (watch mode)
pnpm lint && pnpm typecheck && pnpm test
```

Dependencies (Postgres, Valkey, Mailpit, S3) run in Docker:

```bash
docker compose -f deploy/compose/docker-compose.dev.yml up -d
cat > .env <<ENV
DATABASE_URL=postgres://fiscus_app:fiscus-dev-app@localhost:5432/fiscus
MIGRATION_DATABASE_URL=postgres://fiscus_owner:fiscus-dev-owner@localhost:5432/fiscus
APP_DATABASE_PASSWORD=fiscus-dev-app
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
NODE_ENV=development
LOG_LEVEL=debug
ENV
pnpm db:migrate
pnpm dev
```

Mailpit UI: http://localhost:8025 · S3 API: http://localhost:8333 (`fiscus-dev` / `fiscus-dev-secret`).

No Node 26 yet? `nvm install` (or `fnm use`) reads `.nvmrc`.

### Database

- Schema lives in `packages/db/src/schema` (Drizzle). After changing it, run `pnpm db:generate` and commit the SQL in `packages/db/migrations`. For hand-written SQL (roles, RLS policies, triggers): `pnpm --filter @fiscus/db exec drizzle-kit generate --custom --name=<what>`.
- `pnpm db:migrate` applies migrations using `MIGRATION_DATABASE_URL` (the schema owner; the first run must be a superuser so it can create the `BYPASSRLS` role). Services never migrate on boot.
- Services connect as `fiscus_app` (row-level security enforced). `migrate` enables its login when `APP_DATABASE_PASSWORD` is set.
- Follow [upgrades and migrations](docs/design/upgrades.md): expand/contract, **never edit a merged migration** (CI checks), keep locks short, and run big backfills as jobs.
- Integration tests use `startTestDatabase()` from `@fiscus/db/testing`, which needs Docker.
- Use the column helpers (`id`, `householdId`, `money`, `timestamps`, `versioning`) so tables follow the data-model conventions.

### Web app

- `pnpm dev` serves the web app on http://localhost:5173 and proxies `/api` to the api on :3000, so session cookies behave exactly as in production. Set `VITE_API_PROXY` to point elsewhere.
- Structure follows [information architecture](docs/design/information-architecture.md). Sections are defined once in `apps/web/src/lib/nav.ts`; the sidebar, phone tabs, command palette, and `g <key>` shortcuts all read from it.
- **Components** come from `apps/web/src/components/ui.tsx` (React Aria Components styled with our tokens; see [style guide §11](docs/design/style-guide.md#11-components)). Don't hand-roll buttons, dialogs, menus, or inputs, and don't format money or dates by hand.
- Unit tests: `pnpm --filter @fiscus/web test` (Vitest + happy-dom).
- End-to-end: start the compose stack, then `E2E_SETUP_TOKEN=<token from api logs> pnpm --filter @fiscus/web e2e` (first run: `pnpm --filter @fiscus/web exec playwright install chromium`). The journey needs a **fresh** instance (it performs first-run setup). CI runs it on every PR.
- Accessibility: `e2e/a11y.spec.ts` runs axe (WCAG 2.2 A/AA) on `/styleguide` in both themes, with overlays open too. Any violation fails CI, so a new component belongs on `/styleguide`.

### Household data access

- Household routes live under `/api/v1/households/:householdId/…` and use `@UseGuards(HouseholdGuard)`. The guard resolves membership **before validation** (non-members get 404, missing role 403 via `@HouseholdRoles(...)`), and handlers receive `@Household() ctx`.
- Services reach the database only through `HouseholdScope.run(ctx, tx => …)`, which sets the transaction-local context that row-level security enforces (#19). Worker jobs use `asSystem(householdId, …)`.
- **Every household write records activity in the same transaction** ([ADR 0013](docs/adr/0013-tamper-evident-activity-history.md)): `scope.run(ctx, async (tx, activity) => { …write…; await activity.record({ action: 'thing.changed', targetType, targetId, metadata: { fields }, changes: { before, after } }) })`. Put IDs and field names in `metadata`; put values in `changes`, which are encrypted with the household key. If a transaction changes household rows without recording, it **rolls back** with `UnrecordedWriteError`. A trigger on every household table flags writes; new household tables need the `fiscus_mark_household_write` trigger, and a test fails if one is missing.
- **Permissions:** every rule in [the permissions matrix](docs/design/permissions.md) is either tested for each actor (`[TXN-04/VIEW]` in the test name; most live in `apps/api/src/permissions.test.ts`) or listed as not built yet in `permissions-coverage.test.ts`. Building a rule means moving it from that list to tests; adding a rule to the matrix fails CI until it's covered.
- `apps/api/src/architecture.test.ts` fails if any other file uses the raw DB handle. The allow-list there names each exception and its reason.
- `apps/api/src/cross-tenant.test.ts` is **generated from the route table**: every household route is called with another household's ids and must be indistinguishable from "not found". New routes are covered automatically, and a new kind of path parameter needs a test value.

### Docker images

Each app has a Dockerfile, built from the repository root: `docker build -f apps/api/Dockerfile -t fiscus-api .`
- Images run as non-root, and app files are read-only to the app user.
- `/healthz` (liveness) and `/readyz` (database reachable) on api `:3000` and worker `:3001`; web serves `/healthz` on `:8080`.
- The web image writes `/env.js` from `API_URL` at startup, so one image works behind any proxy.
- Run migrations from the api image: `docker run --rm -e MIGRATION_DATABASE_URL=… fiscus-api node_modules/.bin/fiscus-migrate`.

### Licensing

- **Headers:** every source file (`.ts`, `.tsx`, `.js`, `.mjs`, `.css`, `.sh`) starts with `SPDX-License-Identifier: AGPL-3.0-or-later` in that language's comment style. `pnpm spdx:fix` adds missing ones; CI runs `pnpm spdx:check`. Merged migrations are exempt (they're immutable).
- **Dependencies:** `pnpm licenses:check` (in CI) fails on any license that isn't compatible with AGPL-3.0-or-later. Shipped packages may use MIT, BSD, Apache-2.0, ISC, MPL-2.0, LGPL, GPL-3.0, and similar (the list is in `scripts/check-licenses.mjs`); build-only tools may also use CC-BY data licenses. Wrong or missing metadata gets a reviewed entry in `EXCEPTIONS` with the reason, and a stale exception fails the check too.
- **Notices:** the web build writes `/third-party-licenses.txt` with the license of every bundled package (minifying strips license comments). Server images keep each package's own license files in `node_modules`.
- **Source offer (AGPL §13):** the sign-in pages and Personal settings link to the source code. Anyone running a **modified** Fiscus for others sets `FISCUS_SOURCE_URL` (compose) / `SOURCE_URL` (web image) to their own source.

### Dependencies

- Versions are pinned once in the `catalog:` section of `pnpm-workspace.yaml`. Packages reference them as `"catalog:"`.
- pnpm refuses versions published in the last **7 days** (`minimumReleaseAge`), to blunt hijacked-release attacks. If you need a newer version urgently, add a time-boxed `minimumReleaseAgeExclude` entry with a comment explaining why.
- Packages that need install scripts must be allow-listed under `allowBuilds`.
- **Renovate** (`renovate.json5`) keeps everything current: npm packages and the pnpm catalog, Docker base images, Compose images, pinned GitHub Action SHAs, and versions pinned in Dockerfiles.
  - Routine updates arrive weekly (Monday), grouped by ecosystem, after the same 7-day release age.
  - Dev-dependency and Actions minor/patch updates **auto-merge when CI is green**. Everything else gets a normal review.
  - **Major updates** (Node, Postgres, frameworks) wait for approval on the *Dependency Dashboard* issue, so they happen deliberately.
  - Security fixes (from Dependabot alerts) skip the wait and the schedule, labelled `priority:P0`.
