# Mend bundle: one Mend container plus one official Postgres container at runtime.
# Sealant stays a published platform dependency. These stages copy the released 0.40.0-next.872 artifacts;
# this build never imports sealant source or its database schema. Sealant 0.40.0-next.872 runs its job queue
# in Postgres and keeps workspace images in the host Docker Engine, so the bundle carries no
# RabbitMQ and no registry.
#
# The defaults are the release pins. Only a preview build (.github/workflows/preview.yml) passes
# other sealant images, built from a Sealant branch; a release build passes none of these.
ARG SEALANT_API_IMAGE=ghcr.io/sealant-sh/sealant-api-next@sha256:655b2c8515753f8bc3399319c53114e04b12652917ed48a76aff2899062eecc4
ARG SEALANT_WORKER_IMAGE=ghcr.io/sealant-sh/sealant-worker-next@sha256:d82271f209c857921c1e790e61a917b1bf43fb4d525b4703dd47d8c9f1bd11c3
ARG SEALANT_SSH_GATEWAY_IMAGE=ghcr.io/sealant-sh/sealant-ssh-gateway-next@sha256:5bad52a1d4fd95be6c545d888b193bb519a1e12a94fc3f500904391c2f269c41
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
RUN pnpm --filter @mend/api-server build && pnpm --filter @mend/web build \
  && pnpm --filter @mend/t3-gateway build
RUN node scripts/mend-migrations.mjs > /app/mend-migrations.txt

# The runtime is the same slim Node image the build stages use. Sealant's published bundles
# support this newer Node too.
FROM node:26-bookworm-slim AS runtime

ARG MEND_VERSION=dev
# A preview build's sealantd image (by digest), baked into workspace images by the bundled worker;
# scripts/bundle-supervisor.mjs hands it over. Empty in a release build, which changes nothing.
ARG MEND_PREVIEW_SEALANTD_IMAGE=""
# The image the bundled worker runs for a moment in each workspace to refuse the cloud metadata
# address (Sealant's SEALANT_DOCKER_NETWORK_GUARD_IMAGE). Named once: the worker's ENV below and the
# dev.sealant.mend.network-guard-image label, which `mend server setup` preloads, both read it.
ARG MEND_NETWORK_GUARD_IMAGE=busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e
# sealant's Boat resource gateway, by digest: the bundled worker runs it on the Docker host for Boat
# sessions linked to project resources (@db). Named once: the ENV scripts/bundle-supervisor.mjs
# hands the worker, and the dev.sealant.mend.boat-gateway-image label `mend server setup` preloads.
# scripts/sealant-pins.mjs moves it with the other sealant images.
ARG MEND_BOAT_GATEWAY_IMAGE=ghcr.io/sealant-sh/sealant-boat-gateway-next@sha256:0e3adafebf2318cad8726a5fd015e6a68d94b4161ed661a029f01b1809c2ef42
# dev.sealant.mend.t3-gateway: this image carries the confined t3code gateway (ADR 0012), which
# `mend server setup --t3-gateway` checks for before turning it on. dev.sealant.mend.previews: what
# its previews can do (ADR 0017 step 8b), which setup checks before turning such previews on.
LABEL org.opencontainers.image.title="Mend bundle" \
  org.opencontainers.image.version="${MEND_VERSION}" \
  dev.sealant.mend.t3-gateway="1" \
  dev.sealant.mend.previews="tailnet-ports,same-site-domain" \
  dev.sealant.mend.network-guard-image="${MEND_NETWORK_GUARD_IMAGE}" \
  dev.sealant.mend.boat-gateway-image="${MEND_BOAT_GATEWAY_IMAGE}" \
  dev.sealant.mend.sealant-version="0.40.0-next.872"

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
# The t3code gateway, bundled with the worker that parses messages for find in a thread, in a root
# of its own it is confined to (ADR 0012; review 643-1; scripts/t3-gateway-root.sh). It runs only
# when the operator turned it on, and scripts/bundle-supervisor.mjs starts it there as its own uid
# with no capabilities.
COPY scripts/t3-gateway-root.sh /tmp/t3-gateway-root.sh
RUN /tmp/t3-gateway-root.sh /opt/mend-t3-gateway && rm /tmp/t3-gateway-root.sh
COPY --from=mend-build /app/apps/t3-gateway/dist/bin.js /app/apps/t3-gateway/dist/find-parse-worker.js /opt/mend-t3-gateway/app/
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
# The bundled worker reads boat assets only from boat-assets/ beside dist/.
COPY --from=sealant-worker /app/boat-assets /opt/sealant/worker/boat-assets
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
  SEALANT_DOCKER_NETWORK_GUARD_IMAGE=${MEND_NETWORK_GUARD_IMAGE} \
  MEND_BOAT_GATEWAY_IMAGE=${MEND_BOAT_GATEWAY_IMAGE} \
  HOME=/var/lib/mend/config \
  XDG_CONFIG_HOME=/var/lib/mend/config \
  MEND_MODE=all \
  MEND_STORE_ROOT=/var/lib/mend/store \
  SEALANT_MOUNT_ALLOWED_STORE_ROOTS=/var/lib/mend/store \
  SEALANT_DOCKER_VOLUME_MAPPINGS='[{"logicalRoot":"/var/lib/mend/store","volumeName":"mend-store"},{"logicalRoot":"/run/sealant/sockets","volumeName":"mend-control"}]'

EXPOSE 3105 2222 3120
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=8s --start-period=90s --retries=4 \
  CMD ["node", "/app/scripts/bundle-health.mjs"]
ENTRYPOINT ["node", "/app/scripts/bundle-supervisor.mjs"]
