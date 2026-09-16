#!/usr/bin/env bash
# Run inside deploy/aws/shell.nix. Uses the public, pinned Sealant image recipe.
# Builds a paid AWS image. Does not run a workspace. No credentials enter the context.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF="$HERE/../tofu"
SOURCE_REV=abe4d6c7258a5d6b479b72162de368c45953d9ee
export AWS_REGION=eu-central-1 AWS_PAGER=""
[[ "$(aws sts get-caller-identity --query Account --output text)" == 954648881795 ]] || exit 1
export MICROVM_IMAGE_NAME=mend-capture-poc-workspace
export MICROVM_BUILD_ROLE_ARN="${MICROVM_BUILD_ROLE_ARN:-$(tofu -chdir="$TF" output -raw microvm_build_role_arn)}"
export MICROVM_ARTIFACT_BUCKET="${MICROVM_ARTIFACT_BUCKET:-$(tofu -chdir="$TF" output -raw artifact_bucket)}"
export MICROVM_LOG_GROUP="${MICROVM_LOG_GROUP:-$(tofu -chdir="$TF" output -raw microvm_build_log_group)}"
export MICROVM_MEMORY_MIB=4096
# Set to the explicitly labelled private candidate until the public packaging fix ships.
export SEALANTD_IMAGE="${SEALANTD_IMAGE:-ghcr.io/sealant-sh/sealantd:0.15.2}"
export MICROVM_TAGS='{"project":"mend","environment":"aws-capture-poc"}'
CONTEXT="$(mktemp -d)"
trap 'rm -rf "$CONTEXT"' EXIT
for file in Dockerfile agent.mjs build-image.sh; do
  curl --fail --silent --show-error --location \
    "https://raw.githubusercontent.com/sealant-sh/sealant/$SOURCE_REV/packages/workspaces/microvm-image/$file" \
    -o "$CONTEXT/$file"
done
# The platform recipe contains the runtime, not coding agents. Declare the exact
# additions rather than pretending an arbitrary requested OCI image runs in the VM.
python3 - "$CONTEXT/Dockerfile" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
source = path.read_text()
old = 'npm install -g pnpm@10'
if source.count(old) != 1:
    raise SystemExit('Pinned recipe changed: expected package installation line missing')
path.write_text(source.replace(old, 'npm install -g pnpm@10.32.1 @openai/codex@0.154.0 @anthropic-ai/claude-code@2.1.273'))
PY
bash "$CONTEXT/build-image.sh" "$@"
