#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
json=nix/pnpm-deps.json
previous=$(cat "$json")
fake_hash="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

if command -v sha256sum >/dev/null; then
  lockfile=$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)
else
  lockfile=$(shasum -a 256 pnpm-lock.yaml | cut -d' ' -f1)
fi

write() {
  printf '{\n  "lockfile": "%s",\n  "hash": "%s"\n}\n' "$lockfile" "$1" >"$json"
}

restore() {
  printf '%s\n' "$previous" >"$json"
}

write "$fake_hash"
if output=$(nix build --no-link .#mend.pnpmDeps 2>&1); then
  restore
  echo "The pnpm store built with a fake hash, which should not happen. $json is unchanged." >&2
  exit 1
fi

hash=$(printf '%s\n' "$output" | sed -nE 's/^[[:space:]]*got:[[:space:]]*(sha256-[A-Za-z0-9+/=]+).*/\1/p' | tail -n1)
if [[ -z "$hash" ]]; then
  restore
  printf '%s\n' "$output" >&2
  echo "The pnpm store build failed without a hash mismatch (output above). $json is unchanged." >&2
  exit 1
fi

write "$hash"
nix build --no-link .#mend.pnpmDeps
echo "$json: lockfile $lockfile, hash $hash"
