#!/usr/bin/env bash
# Run a probe MicroVM (no mount in /run) and inspect it through the endpoint:
# who we are, which capabilities we hold, whether the kernel knows NFS, and
# what different mount invocations say. Terminates the VM at the end.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ACCOUNT="$(out account_id)"
IMAGE_ARN="arn:aws:lambda:$REGION:$ACCOUNT:microvm-image:$IMAGE_NAME"
CONNECTOR="$(out vpc_egress_connector_arn)"
EXEC_ROLE="$(out microvm_exec_role_arn)"
FSX_DNS="$(out fsx_dns_name)"
FSX_PATH="$(out fsx_mend_volume_path)"
LOG_GROUP="$(out bench_log_group)"

RUN="$(aws lambda-microvms run-microvm --image-identifier "$IMAGE_ARN" --execution-role-arn "$EXEC_ROLE" \
  --egress-network-connectors "$CONNECTOR" \
  --ingress-network-connectors "arn:aws:lambda:$REGION:aws:network-connector:aws-network-connector:ALL_INGRESS" \
  --idle-policy '{"maxIdleDurationSeconds":900,"suspendedDurationSeconds":60,"autoResumeEnabled":false}' \
  --maximum-duration-in-seconds 1800 --logging "{\"cloudWatch\":{\"logGroup\":\"$LOG_GROUP\"}}" \
  --run-hook-payload '{"probe":true}')"
VM_ID="$(jq -r .microvmId <<<"$RUN")"; ENDPOINT="$(jq -r .endpoint <<<"$RUN")"
trap 'log "terminate $VM_ID"; aws lambda-microvms terminate-microvm --microvm-identifier "$VM_ID" >/dev/null || true' EXIT
log "probe vm $VM_ID"
vm_state() { local s; s="$(aws lambda-microvms get-microvm --microvm-identifier "$VM_ID" --query state --output text)"; case "$s" in RUNNING) echo ok;; TERMINAT*) echo "dead: $s";; *) echo "$s";; esac; }
wait_for 300 5 vm_state
TOKEN="$(aws lambda-microvms create-microvm-auth-token --microvm-identifier "$VM_ID" --expiration-in-minutes 30 --allowed-ports '[{"port":8080}]' --query 'authToken."X-aws-proxy-auth"' --output text)"
x() { curl -sS "https://$ENDPOINT/exec" -H "X-aws-proxy-auth: $TOKEN" -H "X-aws-proxy-port: 8080" -H 'content-type: application/json' \
       -d "$(jq -cn --arg c "$1" '{cmd:$c,timeout:60000}')" | { jq -r '"exit \(.code)\n\(.stdout)\(.stderr)"' 2>/dev/null || cat; }; }
echo "== diag"; curl -sS "https://$ENDPOINT/diag" -H "X-aws-proxy-auth: $TOKEN" -H "X-aws-proxy-port: 8080"
echo; echo "== id / caps"; x 'id; grep -E "Cap(Eff|Bnd|Prm|Inh)" /proc/self/status; cat /proc/1/status | grep -E "^Name|CapEff"; ps -eo pid,user,comm | head -20'
echo "== nfs support"; x 'grep -E "nfs" /proc/filesystems; ls -la /sbin/mount.nfs* /usr/sbin/mount.nfs* 2>&1; rpm -q nfs-utils; cat /etc/os-release | head -3'
echo "== resolve + reach fsx"; x "getent hosts $FSX_DNS; timeout 5 bash -c '</dev/tcp/$FSX_DNS/2049' && echo tcp2049-ok"
for opts in "nfsvers=4.1,nconnect=8,rsize=1048576,wsize=1048576,timeo=600,hard" "vers=4.1" "vers=4.2" "vers=4.0" "vers=3,nolock,proto=tcp"; do
  echo "== mount -o $opts"
  x "mkdir -p /mend && mount -t nfs -o $opts $FSX_DNS:$FSX_PATH /mend 2>&1; echo rc=\$?; grep ' /mend ' /proc/self/mountinfo; umount /mend 2>/dev/null; dmesg 2>&1 | tail -3"
done
echo "== mount.nfs direct + strace-less errno"; x "mount.nfs $FSX_DNS:$FSX_PATH /mend -o vers=4.1 -v 2>&1; echo rc=\$?"
echo "== tmpfs mount (does mount(2) work at all?)"; x 'mkdir -p /tmp/t && mount -t tmpfs none /tmp/t 2>&1; echo rc=$?; umount /tmp/t 2>/dev/null'
echo "== unshare / userns"; x 'unshare -m true 2>&1; echo unshare-rc=$?; cat /proc/sys/user/max_user_namespaces 2>&1'
