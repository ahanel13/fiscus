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
- Fill in the PR template; CI must be green (lint, typecheck, test, build, docker build).
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

Requires Node 22 (`.nvmrc`), pnpm (via `corepack enable`), and Docker.

```bash
corepack enable
pnpm install
docker compose -f deploy/compose/docker-compose.dev.yml up -d   # postgres, redis, mailpit, minio
pnpm db:migrate
pnpm dev
```
