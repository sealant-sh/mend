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
x 'grep -E "Seccomp|NoNewPrivs" /proc/self/status; cat /sys/kernel/security/lsm 2>&1; getenforce 2>&1; ls /sys/fs/selinux 2>&1 | head -2'
x 'dmesg 2>&1 | grep -iE "denied|avc|nfs|landlock|seccomp" | tail -10; echo ---; dmesg 2>&1 | wc -l'
x 'dnf install -y -q strace 2>&1 | tail -2; which strace'
x "strace -f -e trace=mount,fsopen,fsconfig,fsmount,move_mount -o /tmp/st mount -t nfs4 -o vers=4.1 $FSX_DNS:$FSX_PATH /mend 2>&1 | tail -2; echo ---; cat /tmp/st | grep -vE 'exited|SIGCHLD' | tail -8"
x "mount -t nfs4 -o vers=4.1 10.42.28.3:$FSX_PATH /mend 2>&1; echo rc=\$?; mount -t nfs -o vers=4.1,nosharecache,noresvport,lookupcache=none $FSX_DNS:$FSX_PATH /mend 2>&1; echo rc=\$?"
x "unshare -m sh -c 'mount -t nfs4 -o vers=4.1 $FSX_DNS:$FSX_PATH /mend 2>&1; echo rc=\$?'"
x 'mount -t overlay overlay -o lowerdir=/usr,upperdir=/tmp/up,workdir=/tmp/wk /tmp/ov 2>&1 || { mkdir -p /tmp/up /tmp/wk /tmp/ov && mount -t overlay overlay -o lowerdir=/usr,upperdir=/tmp/up,workdir=/tmp/wk /tmp/ov 2>&1; }; echo overlay-rc=$?; umount /tmp/ov 2>/dev/null; mount -t proc proc /tmp/wk 2>&1; echo proc-rc=$?; umount /tmp/wk 2>/dev/null'
x 'cat /proc/net/rpc/nfs 2>&1 | head -2; ls /proc/fs/nfsfs 2>&1; cat /proc/fs/nfsfs/servers 2>&1; ls /sys/module | grep -i -E "nfs|sunrpc|rpc" ; cat /sys/module/nfs/parameters/* 2>/dev/null | head -3'
x 'dnf repoquery --available fuse3 fuse3-libs fuse-sshfs libnfs 2>&1 | tail -6'
x 'dnf install -y -q nfs-utils rpcbind 2>&1 | tail -1; rpcinfo -p 2>&1 | head -3; ls -la /var/lib/nfs 2>&1 | head; systemctl --version 2>&1 | head -1'
