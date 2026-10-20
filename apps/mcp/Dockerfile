# syntax=docker/dockerfile:1.7
# Build from the repository root: docker build -f apps/mcp/Dockerfile .
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
RUN pnpm dlx turbo@2.11.3 prune @fiscus/mcp --docker

FROM base AS build
WORKDIR /repo
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
RUN pnpm turbo run build --filter=@fiscus/mcp
# pnpm's install metadata records when it ran (prunedAt); the app doesn't need it, and the image
# must build identically twice (ADR 0014).
RUN pnpm deploy --filter=@fiscus/mcp --prod --legacy /out && rm /out/node_modules/.modules.yaml

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Files stay root-owned; the app runs as the unprivileged node user and can't modify itself.
COPY --from=build /out .
USER node
# The MCP server speaks stdio for now (run with `docker run -i`). HTTP transport and its
# health endpoints arrive with the streamable HTTP server in M10 (ADR 0009).
HEALTHCHECK NONE
CMD ["node", "--enable-source-maps", "dist/main.js"]
