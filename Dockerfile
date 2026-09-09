# Mend bundle: one Mend container plus one official Postgres container at runtime.
# Sealant stays a published platform dependency. These stages copy the released 0.29.0 artifacts;
# this build never imports Core source or its database schema. Sealant 0.29.0 runs its job queue
# in Postgres and keeps workspace images in the host Docker Engine, so the bundle carries no
# RabbitMQ and no registry.
FROM ghcr.io/sealant-sh/sealant-api@sha256:0ca16620259a2f483381f9b0904a008d6fe46c7c37e028327a59c1ba80396433 AS sealant-api
FROM ghcr.io/sealant-sh/sealant-worker@sha256:c99d9bec9d06477387861d7484f18e4608b0d32c48a3b896c9eb2876bcaafad1 AS sealant-worker
FROM ghcr.io/sealant-sh/sealant-ssh-gateway@sha256:bd7ef3c223cbcdc689d719c16323e49079d24f6bd72e30fb1faf82b8d80b7664 AS sealant-ssh-gateway

# Mend's API server and web front are esbuild-bundled here (tooling/scripts/bundle-app.mjs and
# apps/web/scripts/build-server.mjs), so the runtime ships two self-contained files plus the
# nitro output: no node_modules, no workspace layout, no type stripping. Bundling is also what
# keeps memory down: Node keeps every loaded module's source resident and evaluates everything a
# barrel re-exports, so an unbundled server pays for code it never calls.
FROM node:26-bookworm-slim AS mend-build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install --global corepack && corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @mend/api-server build && pnpm --filter @mend/web build

# The runtime is the same slim Node image the build stages use. Sealant's published bundles
# support this newer Node too.
FROM node:26-bookworm-slim AS runtime

ARG MEND_VERSION=dev
LABEL org.opencontainers.image.title="Mend bundle" \
  org.opencontainers.image.version="${MEND_VERSION}" \
  dev.sealant.mend.sealant-version="0.29.0"

# Required by Sealant's root-owned control sockets and the host Docker socket contract.
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git gh libatomic1 openssh-client procps \
  && rm -rf /var/lib/apt/lists/*

# The released worker carries the Docker 27 CLI and matching buildx plugin it was tested with.
COPY --from=sealant-worker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=sealant-worker /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx

WORKDIR /app
COPY --from=mend-build /app/apps/api/dist ./apps/api/dist
COPY --from=mend-build /app/apps/web/.output ./apps/web/.output
COPY scripts/process-supervisor.mjs scripts/process-supervisor.mjs
COPY scripts/bundle-supervisor.mjs scripts/bundle-supervisor.mjs
COPY scripts/bundle-health.mjs scripts/bundle-health.mjs

COPY --from=sealant-api /app/dist /opt/sealant/api/dist
COPY --from=sealant-api /app/drizzle /opt/sealant/api/drizzle
COPY --from=sealant-api /app/node_modules /opt/sealant/api/node_modules
COPY --from=sealant-worker /app/dist /opt/sealant/worker/dist
COPY --from=sealant-worker /app/node_modules /opt/sealant/worker/node_modules
COPY --from=sealant-ssh-gateway /app/dist /opt/sealant/ssh-gateway/dist
COPY --from=sealant-ssh-gateway /app/node_modules /opt/sealant/ssh-gateway/node_modules
RUN mkdir -p /var/lib/mend/store /var/lib/mend/config /var/lib/mend/ssh /run/sealant/sockets /run/mend-bundle

ENV NODE_ENV=production \
  MEND_VERSION=${MEND_VERSION} \
  HOME=/var/lib/mend/config \
  XDG_CONFIG_HOME=/var/lib/mend/config \
  MEND_MODE=all \
  MEND_STORE_ROOT=/var/lib/mend/store \
  SEALANT_MOUNT_ALLOWED_STORE_ROOTS=/var/lib/mend/store \
  SEALANT_DOCKER_VOLUME_MAPPINGS='[{"logicalRoot":"/var/lib/mend/store","volumeName":"mend-store"},{"logicalRoot":"/run/sealant/sockets","volumeName":"mend-control"}]'

EXPOSE 3105 2222
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=8s --start-period=90s --retries=4 \
  CMD ["node", "/app/scripts/bundle-health.mjs"]
ENTRYPOINT ["node", "/app/scripts/bundle-supervisor.mjs"]
