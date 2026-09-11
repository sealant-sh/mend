#!/usr/bin/env bash
# Run one bench MicroVM against FSx and print the benchmark results.
#
# Usage: 02-run-bench.sh [repo-url] [runs] [install:0|1]
#   repo-url defaults to the Mend monorepo; install=1 also times `pnpm install`.
#
# What happens: RunMicrovm with the VPC egress connector and a run-hook payload
# naming the FSx export → the VM mounts it in /run (fails the VM if it cannot)
# → the bench runs → we poll GET /results through the VM endpoint with a token.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
command -v jq >/dev/null || { log "jq required"; exit 1; }

REPO="${1:-https://github.com/sealant-sh/mend.git}"
RUNS="${2:-3}"
INSTALL="${3:-0}"

ACCOUNT="$(out account_id)"
IMAGE_ARN="arn:aws:lambda:$REGION:$ACCOUNT:microvm-image:$IMAGE_NAME"
CONNECTOR="$(out vpc_egress_connector_arn)"
EXEC_ROLE="$(out microvm_exec_role_arn)"
FSX_DNS="$(out fsx_dns_name)"
FSX_PATH="$(out fsx_mend_volume_path)"
LOG_GROUP="$(out bench_log_group)"

PAYLOAD="$(jq -cn --arg dns "$FSX_DNS" --arg path "$FSX_PATH" --arg repo "$REPO" --argjson runs "$RUNS" --argjson install "$INSTALL" \
  '{fsx:{dns:$dns,path:$path}, mountPoint:"/mend", bench:{repo:$repo, runs:$runs, install:($install==1)}}')"

log "run-microvm image=$IMAGE_NAME connector=$CONNECTOR"
RUN="$(aws lambda-microvms run-microvm \
  --image-identifier "$IMAGE_ARN" \
  --execution-role-arn "$EXEC_ROLE" \
  --egress-network-connectors "$CONNECTOR" \
  --ingress-network-connectors "arn:aws:lambda:$REGION:aws:network-connector:aws-network-connector:ALL_INGRESS" \
  --idle-policy '{"maxIdleDurationSeconds":3600,"suspendedDurationSeconds":600,"autoResumeEnabled":true}' \
  --maximum-duration-in-seconds 7200 \
  --logging "{\"cloudWatch\":{\"logGroup\":\"$LOG_GROUP\"}}" \
  --run-hook-payload "$PAYLOAD" \
  --tags "$TAGS")"
VM_ID="$(jq -r .microvmId <<<"$RUN")"
ENDPOINT="$(jq -r .endpoint <<<"$RUN")"
T0=$(date +%s)
log "microvm $VM_ID endpoint $ENDPOINT"

vm_state() {
  local s; s="$(aws lambda-microvms get-microvm --microvm-identifier "$VM_ID" --query state --output text)"
  case "$s" in RUNNING) echo ok;; TERMINAT*) echo "dead: $s $(aws lambda-microvms get-microvm --microvm-identifier "$VM_ID" --query stateReason --output text)";; *) echo "$s";; esac
}
wait_for 600 5 vm_state || { log "VM did not reach RUNNING; check $LOG_GROUP"; exit 1; }
T1=$(date +%s)
log "RUNNING after $((T1 - T0)) s (includes the /run hook: FSx mount + validation)"

TOKEN="$(aws lambda-microvms create-microvm-auth-token --microvm-identifier "$VM_ID" \
  --expiration-in-minutes 60 --allowed-ports '[{"port":8080}]' --query token --output text)"
get() { curl -sf "https://$ENDPOINT$1" -H "X-aws-proxy-auth: $TOKEN" -H "X-aws-proxy-port: 8080"; }

health_check() { get /health | jq -r 'if .mount then "ok" else "no mount yet" end'; }
wait_for 120 3 health_check
log "health: $(get /health | jq -c '{microvmId,mount:.mount.mountPoint,mountedAt:.mount.mountedAt}')"

results_check() { get /results | jq -r 'if .bench then "ok" else "running" end'; }
log "waiting for the benchmark (clone + git ops + optional pnpm install)…"
wait_for 3600 15 results_check
OUT="$AWS_DIR/results/$(date +%Y%m%d-%H%M%S)-$VM_ID.json"
mkdir -p "$(dirname "$OUT")"
get /results | jq '.bench' > "$OUT"
log "results → $OUT"
jq -r '.results | to_entries[] | "\(.key)\t\(.value|tostring)"' "$OUT" | column -t -s $'\t'

echo
echo "VM $VM_ID is still RUNNING (auto-suspends after 1 h idle, hard stop at 2 h)."
echo "Shell:      ./scripts/03-shell.sh $VM_ID"
echo "Terminate:  ./scripts/04-terminate.sh $VM_ID   (or with no args: every POC VM)"
