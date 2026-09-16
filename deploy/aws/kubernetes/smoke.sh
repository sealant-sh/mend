#!/usr/bin/env bash
set -euo pipefail

namespace=sealant
build_namespace=sealant-build
secret=sealant-secrets
request_file=
launch=false
while [[ $# -gt 0 ]]; do
  case "$1" in
  --namespace)
    namespace=$2
    shift 2
    ;;
  --build-namespace)
    build_namespace=$2
    shift 2
    ;;
  --secret)
    secret=$2
    shift 2
    ;;
  --workspace-request)
    request_file=$2
    shift 2
    ;;
  --launch)
    launch=true
    shift
    ;;
  *)
    echo "unknown argument: $1" >&2
    exit 2
    ;;
  esac
done
if [[ $launch == true && -z $request_file ]]; then
  echo "--launch requires --workspace-request FILE" >&2
  exit 2
fi
for command in kubectl curl python3; do
  command -v "$command" >/dev/null || {
    echo "missing command: $command" >&2
    exit 2
  }
done
if [[ -z ${KUBECONFIG:-} ]]; then
  echo "Set the explicit POC KUBECONFIG; never use an implicit current cluster" >&2
  exit 2
fi
current_context=$(kubectl config current-context 2>/dev/null) || {
  echo "Cannot read the current context from the explicit POC KUBECONFIG" >&2
  exit 1
}
if [[ $current_context != mend-aws-capture-poc ]]; then
  echo "Refusing a kubeconfig context other than mend-aws-capture-poc" >&2
  exit 1
fi

kubectl -n "$namespace" wait --for=condition=available deployment/sealant-registry --timeout=5m
kubectl -n "$namespace" wait --for=condition=available deployment/sealant-api --timeout=5m
kubectl -n "$namespace" wait --for=condition=available deployment/sealant-worker --timeout=5m

if kubectl -n "$namespace" get deployment/sealant-worker -o jsonpath='{.spec.template.spec.containers[0].envFrom[*].configMapRef.name}' |
  grep -qw sealant-worker-config; then :; else
  echo "worker does not reference sealant-worker-config" >&2
  exit 1
fi
if kubectl -n "$namespace" get configmap/sealant-worker-config -o jsonpath='{.data.SEALANT_K8S_NAMESPACE}' | grep -q .; then
  echo "SEALANT_K8S_NAMESPACE is set; this would switch launch-material staging away from the MicroVM path" >&2
  exit 1
fi
[[ $(kubectl auth can-i --as="system:serviceaccount:$namespace:sealant-worker" create jobs.batch -n "$build_namespace") == yes ]]
[[ $(kubectl auth can-i --as="system:serviceaccount:$namespace:sealant-worker" create pods -n "$build_namespace") == no ]]

api_log=$(mktemp)
registry_log=$(mktemp)
kubectl -n "$namespace" port-forward service/sealant-api 14000:4000 >"$api_log" 2>&1 &
api_pf=$!
kubectl -n "$namespace" port-forward service/sealant-registry 15000:5000 >"$registry_log" 2>&1 &
registry_pf=$!
cleanup() {
  kill "$api_pf" "$registry_pf" 2>/dev/null || true
  wait "$api_pf" "$registry_pf" 2>/dev/null || true
  rm -f "$api_log" "$registry_log"
  unset service_key service_keys
}
trap cleanup EXIT
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:14000/healthz >/dev/null && curl -fsS http://127.0.0.1:15000/v2/ >/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:14000/healthz >/dev/null
curl -fsS http://127.0.0.1:15000/v2/ >/dev/null
echo "observed: API /healthz and Zot /v2/ answer through cluster-local Services"

if [[ $launch != true ]]; then
  echo "not executed: workspace build and MicroVM launch (pass --launch --workspace-request FILE after approval)"
  exit 0
fi

owner_query=$(
  python3 - "$request_file" <<'PY'
import json
import sys
from urllib.parse import quote

try:
    request = json.loads(open(sys.argv[1], encoding="utf-8").read())
    owner = request.get("ownerUserId") if isinstance(request, dict) else None
    if not isinstance(owner, str) or not owner:
        raise ValueError
except (OSError, json.JSONDecodeError, ValueError):
    raise SystemExit(2) from None
print(quote(owner, safe=""))
PY
) || {
  echo "workspace request must be JSON with a non-empty ownerUserId" >&2
  exit 2
}
service_keys=$(kubectl -n "$namespace" get secret "$secret" -o jsonpath='{.data.SEALANT_SERVICE_KEYS}' | base64 -d)
service_key=${service_keys%%,*}
unset service_keys
[[ -n $service_key ]] || {
  echo "Secret $secret has no SEALANT_SERVICE_KEYS value" >&2
  exit 1
}
core_request() {
  local url=$1
  shift
  # Reading headers from stdin keeps the bearer value out of argv and process listings.
  printf 'authorization: Bearer %s\n' "$service_key" | curl -fsS --header @- "$@" "$url"
}
response=$(core_request http://127.0.0.1:14000/v1/workspaces \
  -X POST \
  -H 'content-type: application/json' \
  --data-binary "@$request_file")
workspace_id=$(python3 -c '
import json, sys
try:
    value = json.load(sys.stdin)
except json.JSONDecodeError:
    raise SystemExit(2) from None
workspace_id = value.get("workspaceId") if isinstance(value, dict) else None
print(workspace_id if isinstance(workspace_id, str) else "")
' <<<"$response") || {
  echo "create response was not valid JSON" >&2
  exit 1
}
[[ -n $workspace_id ]] || {
  echo "create response has no workspace id" >&2
  exit 1
}

for _ in $(seq 1 180); do
  response=$(core_request "http://127.0.0.1:14000/v1/workspaces/$workspace_id?ownerUserId=$owner_query")
  result=$(python3 -c '
import json, sys
try:
    value = json.load(sys.stdin)
except json.JSONDecodeError:
    raise SystemExit(2) from None
runtime = value.get("runtime") if isinstance(value, dict) else None
published = value.get("publishedImage") if isinstance(value, dict) else None
workspace_status = value.get("status") if isinstance(value, dict) else None
runtime_status = runtime.get("status") if isinstance(runtime, dict) else None
if workspace_status in ("failed", "cancelled", "stopped") or runtime_status in ("failed", "stopped"):
    print("failed")
elif (
    workspace_status == "ready"
    and isinstance(runtime, dict)
    and runtime.get("adapter") == "microvm"
    and runtime_status == "ready"
    and isinstance(published, dict)
    and bool(published.get("digest"))
):
    print("ok")
else:
    print("waiting")
' <<<"$response") || {
    echo "workspace status response was not valid JSON" >&2
    exit 1
  }
  [[ $result == ok ]] && break
  if [[ $result == failed ]]; then
    echo "workspace entered a terminal failure state; inspect it through authenticated Core tooling" >&2
    exit 1
  fi
  sleep 5
done
[[ ${result:-waiting} == ok ]] || {
  echo "workspace did not publish and launch within 15 minutes" >&2
  exit 1
}
echo "observed: the build pipeline published an OCI artifact and the runtime adapter reported microvm"
echo "note: those are separate phases; this test does not claim the published OCI image was launched by the MicroVM"
