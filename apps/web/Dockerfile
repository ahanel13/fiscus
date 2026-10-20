# syntax=docker/dockerfile:1.7
# Build from the repository root: docker build -f apps/web/Dockerfile .
ARG NODE_IMAGE=node:26-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH TURBO_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Node 25+ no longer bundles corepack; install it, then let it provide the pnpm version pinned
# in package.json (packageManager).
RUN npm install -g corepack@0.36.0 && corepack enable pnpm

FROM base AS prune
WORKDIR /repo
COPY . .
# File modes and times come from the checkout: the umask of whoever cloned it, and when. Normalize
# them so the image doesn't depend on either (ADR 0014): times are set to now, which the build then
# clamps to the commit's time (SOURCE_DATE_EPOCH, scripts/build-image.sh).
RUN chmod -R u=rwX,go=rX . && find . -exec touch -h {} +
RUN pnpm dlx turbo@2.11.3 prune @fiscus/web --docker

FROM base AS build
WORKDIR /repo
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
RUN pnpm turbo run build --filter=@fiscus/web

FROM nginxinc/nginx-unprivileged:1.30-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03 AS runtime
COPY --from=prune --chmod=0644 /repo/apps/web/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=prune --chmod=0755 /repo/apps/web/docker/40-fiscus-env.sh /docker-entrypoint.d/40-fiscus-env.sh
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:8080/healthz || exit 1
