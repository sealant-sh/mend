#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 RENDERED_MANIFEST" >&2
  exit 2
fi

manifest=$1
[[ -s $manifest ]] || {
  echo "manifest is missing or empty: $manifest" >&2
  exit 2
}
if grep -Eq '__[A-Z0-9_]+__' "$manifest"; then
  echo "manifest contains unresolved placeholders" >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*SEALANT_K8S_NAMESPACE:' "$manifest"; then
  echo "SEALANT_K8S_NAMESPACE must remain unset; only the build namespace is configured" >&2
  exit 1
fi
for expected in \
  'DEFAULT_RUNTIME_ADAPTER: microvm' \
  'DOCKER_RUNTIME_ENABLED: "false"' \
  'SEALANT_K8S_BUILD_CPU_REQUEST: 500m' \
  'SEALANT_K8S_BUILD_MEMORY_REQUEST: 1Gi' \
  'ghcr.io/sealant-sh/sealant-api:0.32.0' \
  'ghcr.io/sealant-sh/sealant-worker:0.32.0'; do
  grep -Fq "$expected" "$manifest" || {
    echo "missing required pin: $expected" >&2
    exit 1
  }
done

if command -v helm >/dev/null; then
  scratch=$(mktemp -d)
  trap 'rm -rf "$scratch"' EXIT
  mkdir -p "$scratch/templates"
  printf 'apiVersion: v2\nname: sealant-aws-validate\nversion: 0.0.0\n' >"$scratch/Chart.yaml"
  cp "$manifest" "$scratch/templates/resources.yaml"
  # Helm parses and re-emits every YAML document locally. It contacts no cluster.
  helm template sealant-aws-validate "$scratch" >/dev/null
elif command -v kubeconform >/dev/null; then
  kubeconform -strict "$manifest"
else
  echo "warning: helm/kubeconform not found; skipped YAML object decode" >&2
fi
