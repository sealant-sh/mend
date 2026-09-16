#!/usr/bin/env bash
# Exercise the public image-recipe wrapper with local command fixtures. No AWS calls or builds.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/bin" "$ROOT/platform" "$ROOT/output"
for recipe in Dockerfile Dockerfile.docker; do
  printf 'RUN npm install -g pnpm@10\n' > "$ROOT/platform/$recipe"
done
printf '// fixture\n' > "$ROOT/platform/agent.mjs"
printf '// fixture\n' > "$ROOT/platform/docker-service.mjs"
printf '#!/bin/sh\n' > "$ROOT/platform/download-docker.sh"
cat > "$ROOT/platform/build-image.sh" <<'BUILD'
#!/usr/bin/env bash
set -euo pipefail
cp "$(dirname "$0")"/* "$FAKE_OUTPUT/"
printf '%s\n' "$MICROVM_IMAGE_NAME" "${MICROVM_DOCKER_IMAGE_NAME:-}" "${MICROVM_DOCKER_ENABLED:-false}" > "$FAKE_OUTPUT/selection"
BUILD
cat > "$ROOT/bin/aws" <<'AWS'
#!/usr/bin/env bash
set -euo pipefail
printf 'called\n' >> "$FAKE_OUTPUT/aws-calls"
[[ "$*" == 'sts get-caller-identity --query Account --output text' ]] || exit 91
printf '%s\n' "${FAKE_ACCOUNT:-954648881795}"
AWS
cat > "$ROOT/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
url= destination=
while (( $# )); do
  case "$1" in
    -o) destination=$2; shift 2 ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
printf '%s\n' "$url" >> "$FAKE_OUTPUT/downloads"
cp "$FAKE_PLATFORM/${url##*/}" "$destination"
CURL
chmod +x "$ROOT/bin/"*
run() {
  rm -f "$ROOT/output/"*
  env -u SEALANT_MICROVM_SOURCE_DIR -u SEALANT_MICROVM_SOURCE_REV \
    -u MICROVM_DOCKER_IMAGE_NAME -u MICROVM_DOCKER_ENABLED \
    PATH="$ROOT/bin:$PATH" FAKE_OUTPUT="$ROOT/output" FAKE_PLATFORM="$ROOT/platform" \
    MICROVM_BUILD_ROLE_ARN=fixture-role MICROVM_ARTIFACT_BUCKET=fixture-bucket \
    MICROVM_LOG_GROUP=fixture-log "$@" bash "$HERE/build-workspace-image.sh"
}
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
refused() {
  if run "$@" > "$ROOT/last.log" 2>&1; then fail 'unsafe configuration was accepted'; fi
  [[ ! -e "$ROOT/output/aws-calls" ]] || fail 'invalid configuration reached AWS'
  [[ ! -e "$ROOT/output/selection" ]] || fail 'invalid configuration reached builder'
}

run
[[ $(wc -l < "$ROOT/output/downloads") -eq 3 ]] || fail 'legacy recipe download changed'
grep -Fq 'abe4d6c7258a5d6b479b72162de368c45953d9ee/' "$ROOT/output/downloads"
grep -Fq 'pnpm@10.32.1 @openai/codex@0.154.0 @anthropic-ai/claude-code@2.1.273' "$ROOT/output/Dockerfile"
printf 'ok - legacy pinned build preserved\n'

run MICROVM_DOCKER_ENABLED=true MICROVM_DOCKER_IMAGE_NAME=mend-docker-candidate \
  SEALANT_MICROVM_SOURCE_DIR="$ROOT/platform"
[[ ! -e "$ROOT/output/downloads" ]] || fail 'local recipe fetched remote files'
[[ -f "$ROOT/output/docker-service.mjs" && -f "$ROOT/output/download-docker.sh" ]] || fail 'Docker recipe incomplete'
grep -Fxq 'mend-capture-poc-workspace' "$ROOT/output/selection"
grep -Fxq 'mend-docker-candidate' "$ROOT/output/selection"
grep -Fq 'pnpm@10.32.1 @openai/codex@0.154.0 @anthropic-ai/claude-code@2.1.273' "$ROOT/output/Dockerfile.docker"
printf 'ok - local Docker recipe staged explicitly with pinned coding tools\n'

REV=1111111111111111111111111111111111111111
run MICROVM_DOCKER_ENABLED=true MICROVM_DOCKER_IMAGE_NAME=mend-docker-candidate \
  SEALANT_MICROVM_SOURCE_REV="$REV"
[[ $(wc -l < "$ROOT/output/downloads") -eq 6 ]] || fail 'modern recipe download incomplete'
grep -Fq "$REV/packages/workspaces/microvm-image/docker-service.mjs" "$ROOT/output/downloads"
printf 'ok - immutable remote Docker recipe supported\n'

refused MICROVM_DOCKER_ENABLED=true MICROVM_DOCKER_IMAGE_NAME=mend-docker-candidate
refused MICROVM_DOCKER_ENABLED=1
refused SEALANT_MICROVM_SOURCE_REV=main
refused MICROVM_DOCKER_ENABLED=true SEALANT_MICROVM_SOURCE_DIR="$ROOT/platform"
refused MICROVM_DOCKER_ENABLED=true MICROVM_DOCKER_IMAGE_NAME=mend-capture-poc-workspace \
  SEALANT_MICROVM_SOURCE_DIR="$ROOT/platform"
refused SEALANT_MICROVM_SOURCE_DIR="$ROOT/platform" SEALANT_MICROVM_SOURCE_REV="$REV"
printf 'ok - ambiguous, unsupported and unsafe inputs fail before AWS\n'

mv "$ROOT/platform/docker-service.mjs" "$ROOT/saved-service.mjs"
refused SEALANT_MICROVM_SOURCE_DIR="$ROOT/platform"
ln -s "$ROOT/saved-service.mjs" "$ROOT/platform/docker-service.mjs"
refused SEALANT_MICROVM_SOURCE_DIR="$ROOT/platform"
printf 'ok - missing or symlinked recipe inputs refused\n'

if run FAKE_ACCOUNT=123456789012 > "$ROOT/last.log" 2>&1; then fail 'wrong AWS account accepted'; fi
[[ ! -e "$ROOT/output/selection" ]] || fail 'wrong AWS account reached builder'
printf 'ok - wrong AWS account cannot build\n'
