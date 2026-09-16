#!/usr/bin/env bash
# Run inside deploy/aws/shell.nix. Builds a paid AWS image, never a workspace.
# Default: the existing public, pinned Sealant recipe. Docker requires an explicitly selected
# newer immutable revision or a reviewed local recipe, plus a separate Docker image name.
# Only allowlisted recipe files enter the context; credentials and repository contents do not.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF="$HERE/../tofu"
LEGACY_SOURCE_REV=abe4d6c7258a5d6b479b72162de368c45953d9ee
SOURCE_REV="${SEALANT_MICROVM_SOURCE_REV:-$LEGACY_SOURCE_REV}"
SOURCE_DIR="${SEALANT_MICROVM_SOURCE_DIR:-}"
export MICROVM_DOCKER_ENABLED="${MICROVM_DOCKER_ENABLED-false}"
export MICROVM_IMAGE_NAME=mend-capture-poc-workspace

refuse() { printf '%s\n' "$*" >&2; exit 2; }
(( $# <= 1 )) || refuse 'usage: build-workspace-image.sh [--update]'
[[ "${1-}" == '' || "${1-}" == --update ]] || refuse 'usage: build-workspace-image.sh [--update]'
[[ "$SOURCE_REV" =~ ^[0-9a-f]{40}$ ]] || refuse 'SEALANT_MICROVM_SOURCE_REV must be an immutable 40-character commit SHA'
if [[ -n "$SOURCE_DIR" && -v SEALANT_MICROVM_SOURCE_REV ]]; then
  refuse 'Choose SEALANT_MICROVM_SOURCE_DIR or SEALANT_MICROVM_SOURCE_REV, not both'
fi
case "$MICROVM_DOCKER_ENABLED" in
  false) ;;
  true)
    [[ "${MICROVM_DOCKER_IMAGE_NAME:-}" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || refuse 'Set an explicit MICROVM_DOCKER_IMAGE_NAME'
    [[ "$MICROVM_DOCKER_IMAGE_NAME" != "$MICROVM_IMAGE_NAME" ]] || refuse 'The Docker image name must differ from the deployed default'
    [[ -n "$SOURCE_DIR" || "$SOURCE_REV" != "$LEGACY_SOURCE_REV" ]] || refuse 'Docker requires a reviewed newer platform recipe; the default pinned release does not support it'
    ;;
  *) refuse 'MICROVM_DOCKER_ENABLED must be exactly true or false' ;;
esac

FILES=(Dockerfile agent.mjs build-image.sh)
if [[ -n "$SOURCE_DIR" || "$SOURCE_REV" != "$LEGACY_SOURCE_REV" ]]; then
  FILES+=(Dockerfile.docker download-docker.sh docker-service.mjs)
fi
if [[ -n "$SOURCE_DIR" ]]; then
  for file in "${FILES[@]}"; do
    [[ -f "$SOURCE_DIR/$file" && ! -L "$SOURCE_DIR/$file" ]] || refuse "Missing or symlinked platform recipe input: $file"
  done
fi

export AWS_REGION=eu-central-1 AWS_PAGER=""
[[ "$(aws sts get-caller-identity --query Account --output text)" == 954648881795 ]] || refuse 'Refusing to build outside the approved AWS account'
export MICROVM_BUILD_ROLE_ARN="${MICROVM_BUILD_ROLE_ARN:-$(tofu -chdir="$TF" output -raw microvm_build_role_arn)}"
export MICROVM_ARTIFACT_BUCKET="${MICROVM_ARTIFACT_BUCKET:-$(tofu -chdir="$TF" output -raw artifact_bucket)}"
export MICROVM_LOG_GROUP="${MICROVM_LOG_GROUP:-$(tofu -chdir="$TF" output -raw microvm_build_log_group)}"
export MICROVM_MEMORY_MIB=4096
# Keep the matching private CLI candidate explicit until the public packaging fix ships.
export SEALANTD_IMAGE="${SEALANTD_IMAGE:-ghcr.io/sealant-sh/sealantd:0.15.2}"
export MICROVM_TAGS='{"project":"mend","environment":"aws-capture-poc"}'
CONTEXT="$(mktemp -d)"
trap 'rm -rf "$CONTEXT"' EXIT
for file in "${FILES[@]}"; do
  if [[ -n "$SOURCE_DIR" ]]; then
    cp "$SOURCE_DIR/$file" "$CONTEXT/$file"
  else
    curl --fail --silent --show-error --location \
      "https://raw.githubusercontent.com/sealant-sh/sealant/$SOURCE_REV/packages/workspaces/microvm-image/$file" \
      -o "$CONTEXT/$file"
  fi
done
# The platform recipe contains the runtime, not coding agents. Pin Mend's declared additions in
# both recipes; this does not imply that an arbitrary requested OCI image runs inside the VM.
python3 - "$CONTEXT" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
for name in ("Dockerfile", "Dockerfile.docker"):
    path = root / name
    if not path.exists():
        continue
    source = path.read_text()
    old = 'npm install -g pnpm@10'
    if source.count(old) != 1:
        raise SystemExit(f'Platform recipe changed: expected package installation line missing in {name}')
    path.write_text(source.replace(old, 'npm install -g pnpm@10.32.1 @openai/codex@0.154.0 @anthropic-ai/claude-code@2.1.273'))
PY
bash "$CONTEXT/build-image.sh" "$@"
