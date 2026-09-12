#!/usr/bin/env bash
# Build the slice 0 bench MicroVM image: zip ../microvm-bench, upload to the
# artifact bucket, CreateMicrovmImage with hooks on :9000, 4 GB baseline memory,
# arm64, and the elevated OS capabilities NFS mounting needs. Waits for CREATED.
#
# Usage: 01-build-image.sh            (first build)
#        01-build-image.sh --update   (new version of the same image name)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BUCKET="$(out artifact_bucket)"
BUILD_ROLE="$(out microvm_build_role_arn)"
LOG_GROUP="$(out bench_log_group)"
ACCOUNT="$(out account_id)"
BASE_IMAGE_ARN="${BASE_IMAGE_ARN:-$(aws lambda-microvms list-managed-microvm-images \
  --query "items[?contains(imageArn, 'al2023')] | [0].imageArn" --output text)}"
[[ -n "$BASE_IMAGE_ARN" && "$BASE_IMAGE_ARN" != None ]] || { log "no managed al2023 base image found; set BASE_IMAGE_ARN"; exit 1; }
log "base image $BASE_IMAGE_ARN"

STAMP="$(date +%Y%m%d-%H%M%S)"
KEY="images/$IMAGE_NAME-$STAMP.zip"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
( cd "$AWS_DIR/microvm-bench" && zip -qr "$TMP/app.zip" Dockerfile hooks.mjs bench.sh bench-transfer.sh )
aws s3 cp --only-show-errors "$TMP/app.zip" "s3://$BUCKET/$KEY"
log "uploaded s3://$BUCKET/$KEY"

HOOKS='{"port":9000,
  "microvmImageHooks":{"ready":"ENABLED","readyTimeoutInSeconds":300,"validate":"ENABLED","validateTimeoutInSeconds":300},
  "microvmHooks":{"run":"ENABLED","runTimeoutInSeconds":60,"resume":"ENABLED","resumeTimeoutInSeconds":60,
                  "suspend":"ENABLED","suspendTimeoutInSeconds":30,"terminate":"ENABLED","terminateTimeoutInSeconds":10}}'

IMAGE_ARN="arn:aws:lambda:$REGION:$ACCOUNT:microvm-image:$IMAGE_NAME"
# Update takes the whole configuration again, not a delta, so both paths share it.
COMMON=(
  --description "Mend AWS POC: FSx mount + git benchmark; R1 bucket transfer benchmark"
  --base-image-arn "$BASE_IMAGE_ARN"
  --build-role-arn "$BUILD_ROLE"
  --code-artifact "{\"uri\":\"s3://$BUCKET/$KEY\"}"
  --cpu-configurations '[{"architecture":"ARM_64"}]'
  --resources '[{"minimumMemoryInMiB":4096}]'
  --additional-os-capabilities '["ALL"]'
  --hooks "$HOOKS"
  --logging "{\"cloudWatch\":{\"logGroup\":\"$LOG_GROUP\"}}"
)
if [[ "${1:-}" == "--update" ]]; then
  aws lambda-microvms update-microvm-image --image-identifier "$IMAGE_ARN" "${COMMON[@]}" >/dev/null
else
  aws lambda-microvms create-microvm-image --name "$IMAGE_NAME" --tags "$TAGS" "${COMMON[@]}" >/dev/null
fi
log "image build started: $IMAGE_ARN (logs: $LOG_GROUP)"

state_check() {
  local s; s="$(aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_ARN" --query state --output text)"
  case "$s" in CREATED|UPDATED) echo ok;; *FAILED*) echo "failed: $s";; *) echo "$s";; esac
}
wait_for 1800 20 state_check
aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_ARN" \
  --query '{state:state,version:latestActiveImageVersion,failed:latestFailedImageVersion}' --output table
