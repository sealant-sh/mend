#!/usr/bin/env bash
# R1 (AWS half): bucket ↔ executor throughput from one 4 GB / 2 vCPU MicroVM.
#
# Usage: 09-run-transfer.sh <connector|default> [parallel-streams]
#   connector  VM runs with the VPC egress connector: S3 via the gateway endpoint
#   default    VM runs with no egress connector: the service's public egress path
#
# What happens: the 1 GiB object is uploaded once (R1_BLOB, or generated from
# /dev/urandom), a GET and a PUT are presigned for 30 min, the VM starts with a
# no-mount run payload, receives the URLs over POST /transfer, and the result
# JSON lands in ../results/. The VM is terminated on exit, success or not.
# No FSx involved; the module is applied with enable_fsx=false.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
command -v jq >/dev/null || { log "jq required"; exit 1; }

EGRESS="${1:?connector|default}"
PARALLEL="${2:-8}"
case "$EGRESS" in connector|default) ;; *) log "egress must be connector or default"; exit 1;; esac

ACCOUNT="$(out account_id)"
IMAGE_ARN="arn:aws:lambda:$REGION:$ACCOUNT:microvm-image:$IMAGE_NAME"
CONNECTOR="$(out vpc_egress_connector_arn)"
EXEC_ROLE="$(out microvm_exec_role_arn)"
BUCKET="$(out artifact_bucket)"
LOG_GROUP="$(out bench_log_group)"
SIZE=1073741824
GET_KEY="r1/blob-1g.bin"
STAMP="$(date +%Y%m%d-%H%M%S)"
PUT_KEY="r1/put-$STAMP-$EGRESS.bin"

# The object: incompressible, uploaded once.
if ! aws s3api head-object --bucket "$BUCKET" --key "$GET_KEY" >/dev/null 2>&1; then
  BLOB="${R1_BLOB:-$AWS_DIR/results/blob-1g.bin}"
  if [[ ! -s "$BLOB" ]]; then log "generating 1 GiB of /dev/urandom at $BLOB"; head -c "$SIZE" /dev/urandom > "$BLOB"; fi
  log "uploading $BLOB → s3://$BUCKET/$GET_KEY"
  aws s3 cp --only-show-errors "$BLOB" "s3://$BUCKET/$GET_KEY"
fi
OBJ_SIZE="$(aws s3api head-object --bucket "$BUCKET" --key "$GET_KEY" --query ContentLength --output text)"
[[ "$OBJ_SIZE" == "$SIZE" ]] || { log "object size $OBJ_SIZE != $SIZE"; exit 1; }

URLS="$(python3 "$HERE/presign.py" "$BUCKET" "$GET_KEY" "$PUT_KEY" 1800)"
log "presigned GET+PUT (30 min) for s3://$BUCKET/$GET_KEY → $PUT_KEY"

EGRESS_ARGS=()
[[ "$EGRESS" == connector ]] && EGRESS_ARGS=(--egress-network-connectors "$CONNECTOR")
log "run-microvm image=$IMAGE_NAME egress=$EGRESS ${CONNECTOR:+(${EGRESS_ARGS[*]:-none})}"
T0=$(date +%s%3N)
RUN="$(aws lambda-microvms run-microvm \
  --image-identifier "$IMAGE_ARN" \
  --execution-role-arn "$EXEC_ROLE" \
  "${EGRESS_ARGS[@]}" \
  --ingress-network-connectors "arn:aws:lambda:$REGION:aws:network-connector:aws-network-connector:ALL_INGRESS" \
  --idle-policy '{"maxIdleDurationSeconds":900,"suspendedDurationSeconds":300,"autoResumeEnabled":false}' \
  --maximum-duration-in-seconds 3600 \
  --logging "{\"cloudWatch\":{\"logGroup\":\"$LOG_GROUP\"}}" \
  --run-hook-payload '{"probe":true}')"
T_API=$(date +%s%3N)
VM_ID="$(jq -r .microvmId <<<"$RUN")"
ENDPOINT="$(jq -r .endpoint <<<"$RUN")"
trap 'log "terminate $VM_ID"; aws lambda-microvms terminate-microvm --microvm-identifier "$VM_ID" >/dev/null 2>&1 || true' EXIT
log "microvm $VM_ID endpoint $ENDPOINT (run-microvm call $((T_API - T0)) ms)"

vm_state() {
  local s; s="$(aws lambda-microvms get-microvm --microvm-identifier "$VM_ID" --query state --output text)"
  case "$s" in RUNNING) echo ok;; TERMINAT*) echo "dead: $s $(aws lambda-microvms get-microvm --microvm-identifier "$VM_ID" --query stateReason --output text)";; *) echo "$s";; esac
}
wait_for 600 1 vm_state || { log "VM did not reach RUNNING; check $LOG_GROUP"; exit 1; }
T1=$(date +%s%3N)
BOOT_MS=$((T1 - T0))
log "RUNNING after $BOOT_MS ms (no mount in /run)"

TOKEN="$(aws lambda-microvms create-microvm-auth-token --microvm-identifier "$VM_ID" \
  --expiration-in-minutes 60 --allowed-ports '[{"port":8080}]' --query 'authToken."X-aws-proxy-auth"' --output text)"
get() { curl -sf "https://$ENDPOINT$1" -H "X-aws-proxy-auth: $TOKEN" -H "X-aws-proxy-port: 8080"; }
post() { curl -sf -X POST "https://$ENDPOINT$1" -H "X-aws-proxy-auth: $TOKEN" -H "X-aws-proxy-port: 8080" -H 'content-type: application/json' --data-binary @-; }

health_check() { get /health | jq -r 'if .ok then "ok" else "not yet" end'; }
wait_for 120 2 health_check
T2=$(date +%s%3N)
log "endpoint healthy after $((T2 - T0)) ms from run-microvm"

SPEC="$(jq -cn --argjson u "$URLS" --arg s3 "s3://$BUCKET/$GET_KEY" --arg egress "$EGRESS" --argjson size "$SIZE" --argjson par "$PARALLEL" \
  '{getUrl:$u.get, putUrl:$u.put, s3Uri:$s3, egress:$egress, size:$size, parallel:$par}')"
post /transfer <<<"$SPEC" | jq -c .
results_check() { get /results | jq -r 'if .bench then "ok" else "running" end'; }
log "waiting for the transfer bench…"
wait_for 1800 10 results_check

# Verify the PUT landed with the right size, then delete it: nothing stays in the bucket.
PUT_SIZE="$(aws s3api head-object --bucket "$BUCKET" --key "$PUT_KEY" --query ContentLength --output text 2>/dev/null || echo 0)"
aws s3 rm --only-show-errors "s3://$BUCKET/$PUT_KEY" 2>/dev/null || true

OUT="$AWS_DIR/results/$STAMP-transfer-$EGRESS-$VM_ID.json"
get /results | jq --argjson boot "$BOOT_MS" --argjson healthy "$((T2 - T0))" --argjson putSize "$PUT_SIZE" --arg vm "$VM_ID" --arg egress "$EGRESS" \
  '.bench + {vm:{id:$vm, egress:$egress, runToRunningMs:$boot, runToHealthyMs:$healthy}, putObjectSize:$putSize, log:.log}' > "$OUT"
log "results → $OUT"
jq -r '.results | to_entries[] | "\(.key)\t\(.value|tostring)"' "$OUT" | column -t -s $'\t'
jq -r '"boot \(.vm.runToRunningMs) ms · get \((.results["get_single.speed_down_bps"]/1048576)|floor) MiB/s · get2 \((.results["get_single_2.speed_down_bps"]/1048576)|floor) MiB/s · get×\(.results["get_parallel.streams"]) \((.results["get_parallel.speed_down_bps"]/1048576)|floor) MiB/s · put \((.results["put_single.speed_up_bps"]/1048576)|floor) MiB/s · put size \(.putObjectSize) · disk write \((.results["disk.write_bps"]/1048576)|floor) MiB/s · disk read cold \((.results["disk.read_cold_bps"]/1048576)|floor) MiB/s"' "$OUT"
