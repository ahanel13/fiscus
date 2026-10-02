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
- Every commit is signed off (`git commit -s`) per the [DCO](https://developercertificate.org/). The project is AGPL-3.0-or-later ([ADR 0007](docs/adr/0007-license-agpl.md)).
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
cat > .env <<'ENV'
DATABASE_URL=postgres://fiscus_app:fiscus-dev-app@localhost:5432/fiscus
MIGRATION_DATABASE_URL=postgres://fiscus_owner:fiscus-dev-owner@localhost:5432/fiscus
APP_DATABASE_PASSWORD=fiscus-dev-app
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
- Integration tests use `startTestDatabase()` from `@fiscus/db/testing`, which needs Docker.
- Use the column helpers (`id`, `householdId`, `money`, `timestamps`, `versioning`) so tables follow the data-model conventions.

### Docker images

Each app has a Dockerfile, built from the repository root: `docker build -f apps/api/Dockerfile -t fiscus-api .`
- Images run as non-root, and app files are read-only to the app user.
- `/healthz` (liveness) and `/readyz` (database reachable) on api `:3000` and worker `:3001`; web serves `/healthz` on `:8080`.
- The web image writes `/env.js` from `API_URL` at startup, so one image works behind any proxy.
- Run migrations from the api image: `docker run --rm -e MIGRATION_DATABASE_URL=… fiscus-api node_modules/.bin/fiscus-migrate`.

### Dependencies

- Versions are pinned once in the `catalog:` section of `pnpm-workspace.yaml`. Packages reference them as `"catalog:"`.
- pnpm refuses versions published in the last **7 days** (`minimumReleaseAge`), to blunt hijacked-release attacks. If you need a newer version urgently, add a time-boxed `minimumReleaseAgeExclude` entry with a comment explaining why.
- Packages that need install scripts must be allow-listed under `allowBuilds`.
