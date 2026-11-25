#!/usr/bin/env bash
# Names Mend's server release in Sentry and uploads its bundles' source maps (SLNT-1355), so an
# error from the API, the worker or the t3code gateway reads as source; and the web app's browser
# release beside it, with the browser's maps (SLNT-1356). The release is
# mend-server@<version>, the name the server reports under (apps/api/src/main.ts): MEND_VERSION
# is the image's version. Frames are app:///<file in dist> (@mend/telemetry), so the maps go up
# under that prefix.
#
# Usage: scripts/sentry-release.sh <version>
# Needs SENTRY_AUTH_TOKEN (org:ci), SENTRY_URL and SENTRY_ORG. Without the token (a fork, a run
# without the secret) it says so and succeeds: a release never waits on Sentry.
#
# The bundles are rebuilt here from the same commit and lockfile as the image's (esbuild's output
# is deterministic), so the maps describe the code the image runs.
set -euo pipefail

version=${1:?usage: scripts/sentry-release.sh <version>}
if [[ -z ${SENTRY_AUTH_TOKEN:-} ]]; then
  echo "No SENTRY_AUTH_TOKEN: Sentry hears of no release and no source maps."
  exit 0
fi
: "${SENTRY_URL:?SENTRY_URL is not set}" "${SENTRY_ORG:?SENTRY_ORG is not set}"

release="mend-server@$version"
# Exact, so what reads the token is the CLI this script was written against.
sentry_cli=(npx --yes @sentry/cli@3.8.2)
export SENTRY_PROJECT=mend-server

pnpm --filter @mend/api-server --filter @mend/t3-gateway build

"${sentry_cli[@]}" releases new "$release"
for dist in apps/api/dist apps/t3-gateway/dist; do
  "${sentry_cli[@]}" sourcemaps upload --release "$release" --url-prefix 'app:///' "$dist"
done
"${sentry_cli[@]}" releases finalize "$release"
echo "Sentry release $release, with the API's and the gateway's source maps."

# The browser's release, mend-web@<version>, the name the web app reports under
# (apps/web/src/lib/telemetry-config.ts). Its maps are built `hidden`: the code is byte for byte the
# image's (a hidden map adds no sourceMappingURL), and its frames are the page's own URLs,
# https://<host>/assets/<file>, so the maps go up under `~/assets`. They are uploaded, never served.
web_release="mend-web@$version"
MEND_WEB_SOURCEMAPS=hidden pnpm --filter @mend/web build
SENTRY_PROJECT=mend-web "${sentry_cli[@]}" releases new "$web_release"
SENTRY_PROJECT=mend-web "${sentry_cli[@]}" sourcemaps upload --release "$web_release" \
  --url-prefix '~/assets' apps/web/.output/public/assets
SENTRY_PROJECT=mend-web "${sentry_cli[@]}" releases finalize "$web_release"
echo "Sentry release $web_release, with the browser's source maps."
