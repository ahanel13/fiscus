# syntax=docker/dockerfile:1.7
# Build from the repository root: docker build -f apps/api/Dockerfile .
ARG NODE_IMAGE=node:26-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH TURBO_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Node 25+ no longer bundles corepack; install it, then let it provide the pnpm version pinned
# in package.json (packageManager).
RUN npm install -g corepack@0.36.0 && corepack enable pnpm

# Reduce the monorepo to this app and its workspace dependencies.
FROM base AS prune
WORKDIR /repo
COPY . .
# File modes and times come from the checkout: the umask of whoever cloned it, and when. Normalize
# them so the image doesn't depend on either (ADR 0014): times are set to now, which the build then
# clamps to the commit's time (SOURCE_DATE_EPOCH, scripts/build-image.sh).
RUN chmod -R u=rwX,go=rX . && find . -exec touch -h {} +
RUN pnpm dlx turbo@2.11.3 prune @fiscus/api --docker

FROM base AS build
WORKDIR /repo
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
RUN pnpm turbo run build --filter=@fiscus/api
# The image must build identically twice (ADR 0014). pnpm's install metadata records when it ran
# (prunedAt), and the app doesn't need it. Files are copied, not hardlinked from the store: which
# identical files end up sharing a link varies from one build to the next, and a layer records it.
# Modes are normalized too: pnpm left one package's folder rwxrwxrwx in one build and rwxr-xr-x
# in the next (#390, found with scripts/compare-images.sh). `X` keeps executables executable.
RUN pnpm deploy --filter=@fiscus/api --prod --legacy --config.package-import-method=copy /out \
  && rm /out/node_modules/.modules.yaml \
  && chmod -R u=rwX,go=rX /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
# pg_dump for the pre-upgrade and scheduled backups (upgrades.md §5, security/backups.md), matching
# the Postgres 18 server, and age to encrypt them; /backups is where they go, as the node user.
# Versions are pinned so a commit always installs the same packages (ADR 0014); when Alpine replaces
# one, the build fails until Renovate bumps it here.
RUN apk add --no-cache --no-logfile postgresql18-client=18.6-r0 age=1.3.2-r1 \
  && mkdir /backups && chown node:node /backups
WORKDIR /app
# Files stay root-owned; the app runs as the unprivileged node user and can't modify itself.
COPY --from=build /out .
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/healthz`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
