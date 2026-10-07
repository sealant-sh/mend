# Mend bundle: one Mend container plus one official Postgres container at runtime.
# Sealant stays a published platform dependency. These stages copy the released 0.39.0-next.703 artifacts;
# this build never imports Core source or its database schema. Sealant 0.39.0-next.703 runs its job queue
# in Postgres and keeps workspace images in the host Docker Engine, so the bundle carries no
# RabbitMQ and no registry.
#
# The defaults are the release pins. Only a preview build (.github/workflows/preview.yml) passes
# other Core images, built from a Sealant branch; a release build passes none of these.
ARG SEALANT_API_IMAGE=ghcr.io/sealant-sh/sealant-api-next@sha256:fca5b8233f970bcf90ed0633a77466ed1753e3a0397661068f2eabe6d842f4ab
ARG SEALANT_WORKER_IMAGE=ghcr.io/sealant-sh/sealant-worker-next@sha256:0167e2d93f71437f83dc841f6d1026e5f08a7b4ef9bc858deffa02dc0cb9d7a3
ARG SEALANT_SSH_GATEWAY_IMAGE=ghcr.io/sealant-sh/sealant-ssh-gateway-next@sha256:9c397a282a2552e0fc8660b9db6a6f8698d08ed7c9ab15467342797cff079064
FROM ${SEALANT_API_IMAGE} AS sealant-api
FROM ${SEALANT_WORKER_IMAGE} AS sealant-worker
FROM ${SEALANT_SSH_GATEWAY_IMAGE} AS sealant-ssh-gateway

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
RUN node scripts/mend-migrations.mjs > /app/mend-migrations.txt

# The runtime is the same slim Node image the build stages use. Sealant's published bundles
# support this newer Node too.
FROM node:26-bookworm-slim AS runtime

ARG MEND_VERSION=dev
# A preview build's sealantd image (by digest), baked into workspace images by the bundled worker;
# scripts/bundle-supervisor.mjs hands it over. Empty in a release build, which changes nothing.
ARG MEND_PREVIEW_SEALANTD_IMAGE=""
LABEL org.opencontainers.image.title="Mend bundle" \
  org.opencontainers.image.version="${MEND_VERSION}" \
  dev.sealant.mend.sealant-version="0.39.0-next.703"

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
# What Sealant's MicroVM image builder copies into every workspace image it builds: the in-VM agent
# and the guest-local Docker installer. The worker looks for them beside dist/ and refuses to start
# a MicroVM deployment without them. A Docker deployment never reads them.
COPY --from=sealant-worker /app/microvm-image /opt/sealant/worker/microvm-image
COPY --from=sealant-ssh-gateway /app/dist /opt/sealant/ssh-gateway/dist
COPY --from=sealant-ssh-gateway /app/node_modules /opt/sealant/ssh-gateway/node_modules
# Every migration this image carries: Mend's as `mend <id>_<name>`, Sealant's as
# `sealant <folder> <sha256 of migration.sql>` (drizzle's hash). `mend server upgrade --from-preview`
# reads it to refuse a target that lacks, changed or would skip one a server already applied.
COPY --from=mend-build /app/mend-migrations.txt /tmp/mend-migrations.txt
RUN { sed 's/^/mend /' /tmp/mend-migrations.txt; \
    for folder in /opt/sealant/api/drizzle/*/; do \
      if [ -f "${folder}migration.sql" ]; then \
        echo "sealant $(basename "$folder") $(sha256sum "${folder}migration.sql" | cut -d ' ' -f 1)"; \
      fi; \
    done; } > /app/migrations.txt \
  && rm /tmp/mend-migrations.txt \
  && grep -q '^mend ' /app/migrations.txt && grep -q '^sealant ' /app/migrations.txt
RUN mkdir -p /var/lib/mend/store /var/lib/mend/config /var/lib/mend/ssh /run/sealant/sockets /run/mend-bundle

ENV NODE_ENV=production \
  MEND_VERSION=${MEND_VERSION} \
  MEND_PREVIEW_SEALANTD_IMAGE=${MEND_PREVIEW_SEALANTD_IMAGE} \
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
