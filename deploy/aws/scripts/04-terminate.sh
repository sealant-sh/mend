#!/usr/bin/env bash
# Terminate one POC MicroVM, or every one tagged for the POC when no id is given.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
if [[ -n "${1:-}" ]]; then IDS="$1"; else
  IDS="$(aws lambda-microvms list-microvms --query "items[?state!='TERMINATED'].microvmId" --output text)"
fi
for id in $IDS; do
  log "terminate $id"
  aws lambda-microvms terminate-microvm --microvm-identifier "$id" >/dev/null || true
done
