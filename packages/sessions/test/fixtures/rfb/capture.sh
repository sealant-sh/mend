#!/usr/bin/env bash
# Recaptures the RFB fixtures: ./capture.sh from anywhere, with Docker. Writes *.bin, the relayed
# session's final noVNC canvas and capture.json beside this script.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
codec=$(cd "$here/../../../src/screen" && pwd)
image=mend-rfb-capture:local
name=mend-rfb-capture-$$
docker build -q --target capture -t "$image" "$here" >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run --rm --name "$name" --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$here:/out" -v "$here/capture.mjs:/capture/sessions/test/fixtures/rfb/capture.mjs:ro" \
  -v "$codec:/capture/sessions/src/screen:ro" \
  "$image" node /capture/sessions/test/fixtures/rfb/capture.mjs /out
