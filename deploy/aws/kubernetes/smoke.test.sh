#!/usr/bin/env bash
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SMOKE="$HERE/smoke.sh"
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/bin"

cat >"$SCRATCH/bin/kubectl" <<'KUBECTL'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >>"$FAKE_KUBECTL_ARGS"
printf '\n' >>"$FAKE_KUBECTL_ARGS"
case "$*" in
  "config current-context") printf '%s\n' "${FAKE_CONTEXT:-mend-aws-capture-poc}" ;;
  *"port-forward"*) trap 'exit 0' TERM INT; while :; do sleep 1; done ;;
  *"get deployment/sealant-worker"*) printf '%s' sealant-worker-config ;;
  *"get configmap/sealant-worker-config"*) ;;
  *"auth can-i"*"create jobs.batch"*) printf '%s\n' yes ;;
  *"auth can-i"*"create pods"*) printf '%s\n' no ;;
  *"get secret"*) printf '%s' test-service-key | base64 ;;
  *) ;;
esac
KUBECTL

cat >"$SCRATCH/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >>"$FAKE_CURL_ARGS"
printf '\n' >>"$FAKE_CURL_ARGS"
stdin=$(cat)
printf '%s\n' "$stdin" >>"$FAKE_CURL_STDIN"
url=${!#}
case "$url" in
  */healthz|*/v2/) printf '{}' ;;
  */v1/workspaces) printf '{"workspaceId":"ws-1"}' ;;
  */v1/workspaces/ws-1\?ownerUserId=owner%2Fuser%20%2B%201)
    if [[ ${FAKE_WORKSPACE_STATUS:-ready} == failed ]]; then
      printf '{"status":"failed","error":{"message":"DO-NOT-PRINT-RAW-RESPONSE"}}'
    else
      printf '{"status":"ready","runtime":{"adapter":"microvm","status":"ready"},"publishedImage":{"digest":"sha256:test"}}'
    fi
    ;;
  *) echo "unexpected URL: $url" >&2; exit 1 ;;
esac
CURL
chmod +x "$SCRATCH/bin/kubectl" "$SCRATCH/bin/curl"

cat >"$SCRATCH/request.json" <<'JSON'
{"ownerUserId":"owner/user + 1"}
JSON

run_smoke() {
  env \
    PATH="$SCRATCH/bin:$PATH" \
    KUBECONFIG="$SCRATCH/poc-kubeconfig" \
    FAKE_KUBECTL_ARGS="$SCRATCH/kubectl.args" \
    FAKE_CURL_ARGS="$SCRATCH/curl.args" \
    FAKE_CURL_STDIN="$SCRATCH/curl.stdin" \
    "$@" \
    bash "$SMOKE" --workspace-request "$SCRATCH/request.json" --launch </dev/null
}

: >"$SCRATCH/kubectl.args"
: >"$SCRATCH/curl.args"
: >"$SCRATCH/curl.stdin"
output=$(run_smoke 2>&1)
grep -Fq 'runtime adapter reported microvm' <<<"$output"
if grep -Fq 'test-service-key' "$SCRATCH/curl.args"; then
  echo "bearer value leaked into curl argv" >&2
  exit 1
fi
grep -Fq 'authorization: Bearer test-service-key' "$SCRATCH/curl.stdin"
grep -Fq 'ownerUserId=owner%2Fuser%20%2B%201' "$SCRATCH/curl.args"

: >"$SCRATCH/kubectl.args"
: >"$SCRATCH/curl.args"
if output=$(run_smoke FAKE_CONTEXT=other-cluster 2>&1); then
  echo "wrong-context launch unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'Refusing a kubeconfig context other than mend-aws-capture-poc' <<<"$output"
if [[ -s $SCRATCH/curl.args ]]; then
  echo "wrong-context launch reached curl" >&2
  exit 1
fi

: >"$SCRATCH/kubectl.args"
: >"$SCRATCH/curl.args"
: >"$SCRATCH/curl.stdin"
if output=$(run_smoke FAKE_WORKSPACE_STATUS=failed 2>&1); then
  echo "failed workspace unexpectedly passed" >&2
  exit 1
fi
grep -Fq 'workspace entered a terminal failure state' <<<"$output"
if grep -Fq 'DO-NOT-PRINT-RAW-RESPONSE' <<<"$output"; then
  echo "raw workspace response was printed" >&2
  exit 1
fi

printf 'smoke.sh regression checks passed\n'
