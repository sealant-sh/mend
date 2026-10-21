#!/usr/bin/env bash
# The store's handoff admission under the server image's git: the Dockerfile's runtime base, with
# git from its own apt, as the image installs it (git 2.39 on bookworm). CI's runners carry a newer
# git that refuses a hostile tree on its own, so only this run shows the store's checks doing it.
# The working tree's tracked and unignored files go in over stdin; nothing is written back.
#   bash scripts/store-image-git.sh           run the tests
#   bash scripts/store-image-git.sh --image   print the image they run in
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
image=$(sed -n 's/^FROM \([^ ]*\) AS runtime$/\1/p' "$root/Dockerfile")
if [ -z "$image" ]; then
  echo "The Dockerfile names no runtime stage." >&2
  exit 1
fi
if [ "${1:-}" = --image ]; then
  echo "$image"
  exit 0
fi

git -C "$root" ls-files -z --cached --others --exclude-standard |
  tar -C "$root" --null --files-from=- -cf - |
  docker run --rm -i -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$image" bash -euo pipefail -c '
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends ca-certificates git > /dev/null
    npm install --global --silent corepack
    corepack enable
    mkdir /work
    tar -C /work -xf -
    cd /work
    git --version
    pnpm install --frozen-lockfile --filter "@mend/store..." --reporter=append-only
    pnpm --filter @mend/store exec vitest run test/handoff.test.ts
  '
