#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 TOFU_OUTPUT_JSON [KUBECONFIG_PATH]" >&2
  exit 2
fi

outputs=$1
kubeconfig=${2:-"${KUBECONFIG:-$HOME/.kube/config}"}
for command in jq aws; do
  command -v "$command" >/dev/null || {
    echo "missing command: $command" >&2
    exit 2
  }
done

value() {
  jq -er --arg name "$1" '.[$name].value | select(type == "string" and length > 0)' "$outputs"
}

account_id=$(value account_id)
region=$(value region)
cluster_name=$(value cluster_name)
caller_account=$(aws sts get-caller-identity --query Account --output text)
if [[ $caller_account != "$account_id" ]]; then
  echo "AWS caller account $caller_account does not match tofu output account $account_id" >&2
  exit 1
fi

mkdir -p "$(dirname "$kubeconfig")"
aws eks update-kubeconfig \
  --region "$region" \
  --name "$cluster_name" \
  --kubeconfig "$kubeconfig"
printf 'configured local kubeconfig %s for %s in %s\n' "$kubeconfig" "$cluster_name" "$region"
