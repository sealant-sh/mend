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
x 'cat /proc/self/uid_map; echo ---; cat /proc/self/gid_map; echo ---; ls -l /proc/self/ns/; echo ---; cat /proc/self/cgroup; echo ---; cat /proc/1/cmdline | tr "\0" " "; echo'
x 'ls -l /dev/fuse /dev/net/tun 2>&1; grep -c . /proc/mounts; cat /proc/mounts | head -30'
x 'ip addr 2>&1 | head -20; ip route 2>&1'

x "mount -t nfs4 -o vers=4.1,noresvport,sec=sys $FSX_DNS:$FSX_PATH /mend 2>&1; echo rc=\$?"
x 'strace -f -e trace=mount -o /tmp/st mount -t nfs4 -o vers=4.1 '"$FSX_DNS:$FSX_PATH"' /mend 2>&1; cat /tmp/st 2>&1 | tail -5 || echo no-strace'
x 'dnf -q list available fuse fuse3 fuse-nfs libnfs libnfs-utils 2>&1 | tail -8; dnf -q repolist 2>&1 | head'
x 'cat /proc/sys/kernel/unprivileged_userns_clone 2>&1; sysctl -a 2>/dev/null | grep -i userns; capsh --decode=000001ffffffffff 2>/dev/null | head -3'
