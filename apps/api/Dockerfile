# The Mend API server (apps/api): contract + auth + WS data planes + session
# engine + workers (MEND_MODE=all|api|worker). esbuild-bundled into one file
# (tooling/scripts/bundle-app.mjs), so the runtime image carries no
# node_modules and no source. Bundling also tree-shakes what the server never
# calls and keeps V8's resident copy of the source small.
#
# Build context is the REPO ROOT:
#   docker build -f apps/api/Dockerfile -t mend-api .

FROM node:26-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Node >=25 no longer bundles corepack; install it — it still honors the
# packageManager pin in package.json.
RUN npm install -g corepack && corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @mend/api-server build

FROM node:26-slim
# Sessions and adoption need git; mend-key auth mode speaks ssh.
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ARG MEND_VERSION=dev
LABEL org.opencontainers.image.version="${MEND_VERSION}"
ENV NODE_ENV=production MEND_MODE=all PORT=3101 MEND_VERSION=${MEND_VERSION}
WORKDIR /app
COPY --from=build /app/apps/api/dist apps/api/dist
EXPOSE 3101
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT??3101)+'/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]
