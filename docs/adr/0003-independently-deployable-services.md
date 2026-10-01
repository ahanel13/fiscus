# ADR 0003: Independently deployable services

- Status: Accepted
- Date: 2026-09-30

## Context
The maintainer runs a Proxmox cluster and wants to place services on separate LXCs/VMs. The
community mostly wants a single `docker compose up`. Both must work from the same artifacts.

## Decision
- Each app (`api`, `worker`, `web`, `mcp`) builds its **own OCI image**, published to GHCR
  as `ghcr.io/<owner>/fiscus-<service>`, multi-arch (amd64/arm64).
- Services are configured **only via environment variables**, never by assuming a sibling
  hostname. Peers are addressed with `DATABASE_URL`, `REDIS_URL`, `API_URL`, `S3_ENDPOINT`,
  and so on.
- The `web` image injects `API_URL` at container start, so one image works behind any proxy layout.
- Every service exposes `/healthz` (liveness) and `/readyz` (dependencies reachable).
- Storage has a local-disk driver for single-host installs and an S3 driver for multi-host
  installs, since receipts must be reachable from both `api` and `worker`.
- `deploy/compose` ships the all-in-one stack. `deploy/proxmox` documents the per-service
  layout: Postgres LXC, Redis LXC, and app LXCs running the images via Docker or Podman.

## Consequences
- No shared-filesystem assumptions. Multi-host setups need S3-compatible storage (MinIO/Garage).
- Slightly more env configuration. We mitigate that with a documented `.env.example` and
  zod validation that fails fast with a clear message.
