#!/usr/bin/env bash
# Builds tlx, the TLA+ model checker every model's check.sh runs, at the one commit Mend pins, and
# prints the binary's path.
#
#   tlx.sh            build tlx at TLX_COMMIT unless it is built already, then print its path
#   tlx.sh --commit   print TLX_COMMIT
#   tlx.sh --path     print where the binary goes, built or not
#
# tlx (github.com/tlaplus-x/tlx, version 0.1) has no releases, so it is built from source: a
# shallow fetch of TLX_COMMIT, then `cargo build --release --locked`. The binary lives in
# $XDG_CACHE_HOME/mend-formal/tlx-<commit>/tlx, and CI caches that directory by the commit. A
# build takes a few minutes, once per commit; CARGO_BUILD_JOBS caps its jobs.
#
# It needs git, a C compiler and cargo. With rustup, cargo takes the rustc tlx pins in its
# rust-toolchain.toml (1.93.0), as CI's runner does. Without cargo it uses Nix: cargo and rustc
# from the repository's pinned nixpkgs.
#
# A change to TLX_COMMIT is a change to every model: CI checks each one with the new build
# (scripts/formal-coverage.mjs), and each row must still reach the count its check.sh pins.
set -euo pipefail

TLX_REPO=https://github.com/tlaplus-x/tlx
TLX_COMMIT=8d5f082b0f0d922bf5999d9a8db00c70a4c1d261

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
dir="${XDG_CACHE_HOME:-$HOME/.cache}/mend-formal/tlx-$TLX_COMMIT"
bin="$dir/tlx"

usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }

case "${1:-}" in
  "") ;;
  --commit) echo "$TLX_COMMIT"; exit 0 ;;
  --path) echo "$bin"; exit 0 ;;
  -h | --help) usage; exit 0 ;;
  *) echo "tlx.sh: unknown argument $1" >&2; usage >&2; exit 2 ;;
esac

if [[ -x "$bin" ]]; then
  echo "$bin"
  exit 0
fi

if command -v cargo >/dev/null; then
  cargo=(cargo)
elif command -v nix >/dev/null; then
  root=$(git -C "$here" rev-parse --show-toplevel)
  cargo=(nix shell --inputs-from "$root" nixpkgs#cargo nixpkgs#rustc nixpkgs#gcc -c cargo)
else
  echo "tlx.sh: building tlx needs cargo (rustup.rs) or Nix; nothing was built." >&2
  exit 2
fi

work=$(mktemp -d -t mend-tlx.XXXXXX)
trap 'rm -rf -- "$work"' EXIT
echo "tlx.sh: building tlx at ${TLX_COMMIT:0:10} into $dir (a few minutes, once)" >&2
git -c init.defaultBranch=main init -q "$work/src"
git -C "$work/src" fetch -q --depth 1 "$TLX_REPO" "$TLX_COMMIT"
git -C "$work/src" -c advice.detachedHead=false checkout -q FETCH_HEAD
if [[ "$(git -C "$work/src" rev-parse HEAD)" != "$TLX_COMMIT" ]]; then
  echo "tlx.sh: $TLX_REPO did not give commit $TLX_COMMIT; nothing was built." >&2
  exit 2
fi
(cd "$work/src" && "${cargo[@]}" build --release --locked -p tlx-cli) >&2
mkdir -p "$dir"
# Two checks may build at once: each moves its own whole binary into place.
cp "$work/src/target/release/tlx" "$dir/tlx.part.$$"
mv -f "$dir/tlx.part.$$" "$bin"
echo "$bin"
