#!/usr/bin/env bash
# Print how to open a shell into a running POC MicroVM (SHELL_INGRESS is not
# attached by the bench script; use the console "Connect" button, or re-run the
# VM with the SHELL_INGRESS connector and a shell token).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
VM_ID="${1:?microvm id}"
aws lambda-microvms get-microvm --microvm-identifier "$VM_ID" --query '{state:state,endpoint:endpoint,ingress:ingressNetworkConnectors}' --output table
cat <<MSG
To get a shell, the VM must run with the SHELL_INGRESS connector:
  arn:aws:lambda:$REGION:aws:network-connector:aws-network-connector:SHELL_INGRESS
then:
  aws lambda-microvms create-microvm-shell-auth-token --microvm-identifier $VM_ID
and connect from the console (MicroVMs → $VM_ID → Connect).
MSG
