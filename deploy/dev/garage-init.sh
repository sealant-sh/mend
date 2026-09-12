#!/bin/sh
# One-shot layout + key + bucket for the dev Garage in compose.dev.yaml. Run from the repo root
# after `docker compose -f compose.dev.yaml up -d --wait garage`; `pnpm dev` runs it for you when
# MEND_SESSION_STORE=captured. Idempotent: every step tolerates "already exists". The garage
# image ships no shell, so this drives its CLI through `docker compose exec`.
set -eu
cd "$(dirname "$0")/../.."
GARAGE="docker compose -f compose.dev.yaml exec -T garage /garage -c /etc/garage.toml"
NODE_ID="$($GARAGE status | awk '/^[0-9a-f]{16}/ { print $1; exit }')"
if [ -z "$NODE_ID" ]; then
  echo "garage-init: no node in \`garage status\` — is the garage service up?" >&2
  exit 1
fi
$GARAGE layout assign -z dev -c 1GB "$NODE_ID" >/dev/null 2>&1 || true
$GARAGE layout apply --version 1 >/dev/null 2>&1 || true
$GARAGE bucket create mend >/dev/null 2>&1 || true
# A fixed key id + secret so `.env` can name them (DEVELOPMENT.md §Environment).
$GARAGE key import --yes -n mend-dev GK00000000000000000000000d \
  000000000000000000000000000000000000000000000000000000000000000d >/dev/null 2>&1 || true
$GARAGE bucket allow --read --write --owner mend --key mend-dev >/dev/null 2>&1 || true
$GARAGE bucket info mend
