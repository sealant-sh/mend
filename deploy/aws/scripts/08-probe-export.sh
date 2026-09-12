#!/usr/bin/env bash
# Second probe: is the app container in a user namespace (which forbids kernel
# NFS mounts regardless of capabilities), and is FUSE available as a fallback?
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ACCOUNT="$(out account_id)"; IMAGE_ARN="arn:aws:lambda:$REGION:$ACCOUNT:microvm-image:$IMAGE_NAME"
CONNECTOR="$(out vpc_egress_connector_arn)"; EXEC_ROLE="$(out microvm_exec_role_arn)"
FSX_DNS="$(out fsx_dns_name)"; FSX_PATH="$(out fsx_mend_volume_path)"; LOG_GROUP="$(out bench_log_group)"
RUN="$(aws lambda-microvms run-microvm --image-identifier "$IMAGE_ARN" --execution-role-arn "$EXEC_ROLE" \
  --egress-network-connectors "$CONNECTOR" \
  --ingress-network-connectors "arn:aws:lambda:$REGION:aws:network-connector:aws-network-connector:ALL_INGRESS" \
  --idle-policy '{"maxIdleDurationSeconds":900,"suspendedDurationSeconds":60,"autoResumeEnabled":false}' \
  --maximum-duration-in-seconds 1800 --logging "{\"cloudWatch\":{\"logGroup\":\"$LOG_GROUP\"}}" \
  --run-hook-payload '{"probe":true}')"
VM_ID="$(jq -r .microvmId <<<"$RUN")"; ENDPOINT="$(jq -r .endpoint <<<"$RUN")"
trap 'log "terminate $VM_ID"; aws lambda-microvms terminate-microvm --microvm-identifier "$VM_ID" >/dev/null || true' EXIT
vm_state() { local s; s="$(aws lambda-microvms get-microvm --microvm-identifier "$VM_ID" --query state --output text)"; case "$s" in RUNNING) echo ok;; TERMINAT*) echo "dead: $s";; *) echo "$s";; esac; }
wait_for 300 5 vm_state
TOKEN="$(aws lambda-microvms create-microvm-auth-token --microvm-identifier "$VM_ID" --expiration-in-minutes 30 --allowed-ports '[{"port":8080}]' --query 'authToken."X-aws-proxy-auth"' --output text)"
x() { echo "== $1"; curl -sS "https://$ENDPOINT/exec" -H "X-aws-proxy-auth: $TOKEN" -H "X-aws-proxy-port: 8080" -H 'content-type: application/json' \
       -d "$(jq -cn --arg c "$1" '{cmd:$c,timeout:90000}')" | { jq -r '"exit \(.code)\n\(.stdout)\(.stderr)"' 2>/dev/null || cat; }; }
x 'dnf install -y strace 2>&1 | tail -1; which strace rpcdebug'
x "rpcdebug -m nfs -s all >/dev/null 2>&1; rpcdebug -m rpc -s all >/dev/null 2>&1; mount -t nfs4 -o vers=4.1 $FSX_DNS:$FSX_PATH /mend 2>&1; echo rc=\$?; rpcdebug -m nfs -c all >/dev/null 2>&1; rpcdebug -m rpc -c all >/dev/null 2>&1; dmesg 2>&1 | grep -iE 'nfs|rpc' | grep -v Registered | tail -40"
x "strace -f -o /tmp/st mount -t nfs4 -o vers=4.1 $FSX_DNS:$FSX_PATH /mend >/dev/null 2>&1; grep -E 'mount\(|EPERM|EACCES' /tmp/st | tail -6"
x "echo '--- root pseudo-fs'; mount -t nfs4 -o vers=4.1 $FSX_DNS:/ /mend 2>&1; echo rc=\$?; ls -la /mend 2>&1 | head -5; umount /mend 2>/dev/null"
x "echo '--- /fsx root volume (all_squash)'; mount -t nfs4 -o vers=4.1 $FSX_DNS:/fsx /mend 2>&1; echo rc=\$?; umount /mend 2>/dev/null"
x "echo '--- /fsx/mend (export now no_root_squash)'; mount -t nfs4 -o vers=4.1 $FSX_DNS:$FSX_PATH /mend 2>&1; echo rc=\$?; grep ' /mend ' /proc/self/mountinfo; touch /mend/probe && ls -ln /mend && rm -f /mend/probe; umount /mend 2>/dev/null"
