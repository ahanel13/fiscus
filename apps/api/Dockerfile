# syntax=docker/dockerfile:1.7
# Build from the repository root: docker build -f apps/api/Dockerfile .
ARG NODE_IMAGE=node:26-alpine

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH TURBO_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Node 25+ no longer bundles corepack; install it, then let it provide the pnpm version pinned
# in package.json (packageManager).
RUN npm install -g corepack@0.36.0 && corepack enable pnpm

# Reduce the monorepo to this app and its workspace dependencies.
FROM base AS prune
WORKDIR /repo
COPY . .
RUN pnpm dlx turbo@2.11.3 prune @fiscus/api --docker

FROM base AS build
WORKDIR /repo
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
RUN pnpm turbo run build --filter=@fiscus/api
RUN pnpm deploy --filter=@fiscus/api --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
# pg_dump for the migrate job's pre-upgrade backup (upgrades.md §5), matching the Postgres 18
# server; /backups is where it writes, as the node user.
RUN apk add --no-cache postgresql18-client && mkdir /backups && chown node:node /backups
WORKDIR /app
# Files stay root-owned; the app runs as the unprivileged node user and can't modify itself.
COPY --from=build /out .
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/healthz`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
