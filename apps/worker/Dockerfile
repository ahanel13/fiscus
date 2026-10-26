# syntax=docker/dockerfile:1.7
# Build from the repository root: docker build -f apps/worker/Dockerfile .
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
RUN pnpm dlx turbo@2.11.3 prune @fiscus/worker --docker

FROM base AS build
WORKDIR /repo
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
RUN pnpm turbo run build --filter=@fiscus/worker
# The image must build identically twice (ADR 0014). pnpm's install metadata records when it ran
# (prunedAt), and the app doesn't need it. Files are copied, not hardlinked from the store: which
# identical files end up sharing a link varies from one build to the next, and a layer records it.
RUN pnpm deploy --filter=@fiscus/worker --prod --legacy --config.package-import-method=copy /out \
  && rm /out/node_modules/.modules.yaml

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Files stay root-owned; the app runs as the unprivileged node user and can't modify itself.
COPY --from=build /out .
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.HEALTH_PORT ?? 3001}/healthz`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
