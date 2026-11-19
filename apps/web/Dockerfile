# The Mend web tier (apps/web): the TanStack Start app built the official way
# (nitro → self-contained .output/server/index.mjs; /trpc is a Start server
# route inside it) plus the thin front (.output/front.mjs) that relays /api —
# WebSocket upgrades included — to the API tier and supervises the nitro
# server. Ships .output/ ALONE: no source, no node_modules.
#
# Build context is the REPO ROOT (the workspace is needed to compile):
#   docker build -f apps/web/Dockerfile -t mend-web .

FROM node:26-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Node >=25 no longer bundles corepack; install it — it still honors the
# packageManager pin in package.json.
RUN npm install -g corepack && corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @mend/web build

FROM node:26-slim
ARG MEND_VERSION=dev
LABEL org.opencontainers.image.version="${MEND_VERSION}"
ENV NODE_ENV=production PORT=3105 MEND_VERSION=${MEND_VERSION}
WORKDIR /app
COPY --from=build /app/apps/web/.output .output
USER node
EXPOSE 3105
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT??3105)+'/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", ".output/front.mjs"]
