#!/usr/bin/env bash
# Deploy a Mend preview build (.github/workflows/preview.yml) on a self-hosted box.
#
# Run it ON the box, as root, with the mend CLI installed:
#
#   scripts/preview-deploy.sh <version> <mend-commit-sha> [mend server setup options]
#
# or without a checkout:
#
#   curl -fsSL https://raw.githubusercontent.com/sealant-sh/mend/<sha>/scripts/preview-deploy.sh \
#     | bash -s -- <version> <sha>
#
# It takes compose.v2.yaml and postgres-init.sh from that exact Mend commit, pulls
# ghcr.io/sealant-sh/mend:<version>, refuses an image whose version, commit or platform is not the
# one asked for, and runs `mend server setup` when the box has no Mend server
# or `mend server upgrade` when it has one. Options after the commit go to `mend server setup` only;
# an upgrade keeps the installed configuration, the edge (--edge) and the declared exposure and
# tenancy included: the CLI carries the edge overlay and renders it into every generation, so
# nothing beyond the two release assets is fetched here. See docs/operations/preview-builds.md.
set -euo pipefail

readonly REPOSITORY=sealant-sh/mend
readonly IMAGE_REPOSITORY=ghcr.io/sealant-sh/mend
readonly NOT_CONFIGURED="No Mend server is configured"

say() { printf 'preview-deploy: %s\n' "$*"; }
die() {
  printf 'preview-deploy: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
usage: preview-deploy.sh <version> <mend-commit-sha> [mend server setup options]

  version          the version the preview workflow printed, such as 0.36.0-next.56.preview.17
  mend-commit-sha  the full 40-character Mend commit the workflow built
USAGE
  exit 2
}

[[ $# -ge 2 ]] || usage
version=$1
commit=$2
shift 2

[[ $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]] ||
  die "version must be an exact Mend version such as 0.36.0-next.56.preview.17, not \"$version\"."
[[ $commit =~ ^[0-9a-f]{40}$ ]] ||
  die "mend-commit-sha must be the full 40-character commit the workflow printed, not \"$commit\"."
[[ $(id -u) -eq 0 ]] || die "run this as root: mend server setup and upgrade drive the host's Docker."
for tool in mend docker curl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not on PATH."
done

assets=$(mktemp -d)
trap 'rm -rf "$assets"' EXIT

for asset in compose.v2.yaml postgres-init.sh; do
  url="https://raw.githubusercontent.com/$REPOSITORY/$commit/deploy/docker/$asset"
  say "fetching $asset from $REPOSITORY@${commit:0:12}"
  curl -fsSL --retry 3 --output "$assets/$asset" "$url" || die "could not fetch $url"
done

image="$IMAGE_REPOSITORY:$version"
say "pulling $image"
docker pull "$image" || die "could not pull $image. Check the version and that the workflow run finished."
label=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image")
[[ $label == "$version" ]] ||
  die "$image carries org.opencontainers.image.version=\"$label\", expected \"$version\"."
# The compose assets come from <commit> and the image from <version>: one build, or nothing. An image
# without the label (a next build from before image.yml stamped it) cannot be checked, so it is
# refused too.
revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
[[ $revision == "$commit" ]] ||
  die "$image carries org.opencontainers.image.revision=\"$revision\", expected \"$commit\" · nothing deployed."
# An image for another platform pulls (a single-platform image) and then never starts here.
image_platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")
host_platform=$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')
[[ $image_platform == "$host_platform" ]] ||
  die "$image is built for $image_platform and this box runs $host_platform · nothing deployed."

# `mend server status` exits non-zero both when nothing is installed and when an installed server
# is stopped or unhealthy; only the first one means setup.
status_code=0
status_output=$(mend server status 2>&1) || status_code=$?
if [[ $status_code -ne 0 && $status_output == *"$NOT_CONFIGURED"* ]]; then
  say "no Mend server on this box: mend server setup --version $version"
  mend server setup --version "$version" --assets-dir "$assets" "$@"
else
  printf '%s\n' "$status_output"
  if [[ $# -gt 0 ]]; then
    say "a Mend server is installed, so these setup options are ignored: $*"
  fi
  # Sessions live on this box lose their executor's connection in an upgrade (an incident on
  # 2026-10-03 lost a phone session's evidence this way): refuse unless told otherwise. The count
  # is read from the bundled Postgres. A count that cannot be read (Postgres restarting, renamed,
  # or absent) refuses too: no count is not zero sessions.
  live=$(docker exec mend-postgres-1 psql -U mend -d mend -At \
    -c "select count(*) from agent_sessions where settled_at is null" 2>/dev/null || printf '?')
  if [[ $live =~ ^[0-9]+$ ]]; then
    if [[ $live -gt 0 && ${PREVIEW_DEPLOY_EVEN_IF_LIVE:-} != 1 ]]; then
      die "$live session(s) are live on this box · nothing deployed · set PREVIEW_DEPLOY_EVEN_IF_LIVE=1 to upgrade anyway"
    fi
    say "$live session(s) live"
  elif [[ ${PREVIEW_DEPLOY_EVEN_IF_LIVE:-} == 1 ]]; then
    say "could not count live sessions (no bundled Postgres answered) · going on: PREVIEW_DEPLOY_EVEN_IF_LIVE=1"
  else
    die "could not count live sessions (no bundled Postgres answered) · nothing deployed · set PREVIEW_DEPLOY_EVEN_IF_LIVE=1 to upgrade anyway"
  fi
  # The previous container's log would go with the container: kept, the last twenty.
  logs="${MEND_CONFIG_DIR:-/root/.config/mend}/logs"
  mkdir -p "$logs"
  if docker inspect mend-mend-1 >/dev/null 2>&1; then
    previous=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' mend-mend-1 2>/dev/null || printf unknown)
    docker logs mend-mend-1 > "$logs/mend-$(date -u +%Y%m%dT%H%M%SZ)-${previous:-unknown}.log" 2>&1 || true
    ls -1t "$logs"/mend-*.log 2>/dev/null | tail -n +21 | xargs -r rm -f
    say "kept the previous server's log in $logs"
  fi
  say "upgrading the installed Mend server: mend server upgrade --version $version"
  mend server upgrade --version "$version" --assets-dir "$assets"
fi

say "finished for $version from $REPOSITORY@$commit"
mend server status
