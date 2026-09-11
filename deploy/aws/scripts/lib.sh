# Shared helpers for the POC scripts. Source, do not run.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWS_DIR="$(cd "$HERE/.." && pwd)"
TOFU_DIR="$AWS_DIR/tofu"
export AWS_PAGER=""

# out <name>: read one OpenTofu output as a raw string.
out() { tofu -chdir="$TOFU_DIR" output -raw "$1"; }

REGION="${AWS_REGION:-$(out region)}"
export AWS_REGION="$REGION"
IMAGE_NAME="${IMAGE_NAME:-mend-poc-bench}"
TAGS='{"project":"mend","environment":"aws-microvm-poc"}'

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

# wait_for <seconds> <interval> <cmd...>: run cmd until it prints "ok" on stdout.
wait_for() {
  local deadline=$(( $(date +%s) + $1 )) interval="$2"; shift 2
  while true; do
    local r; r="$("$@" 2>/dev/null || true)"
    [[ "$r" == ok* ]] && return 0
    if (( $(date +%s) > deadline )); then log "timeout waiting: $r"; return 1; fi
    sleep "$interval"
  done
}
