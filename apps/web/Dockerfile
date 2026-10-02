# syntax=docker/dockerfile:1.7
# Build from the repository root: docker build -f apps/web/Dockerfile .
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH TURBO_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm

FROM base AS prune
WORKDIR /repo
COPY . .
RUN pnpm dlx turbo@2.11.3 prune @fiscus/web --docker

FROM base AS build
WORKDIR /repo
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
RUN pnpm turbo run build --filter=@fiscus/web

FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
COPY apps/web/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=0755 apps/web/docker/40-fiscus-env.sh /docker-entrypoint.d/40-fiscus-env.sh
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:8080/healthz || exit 1
