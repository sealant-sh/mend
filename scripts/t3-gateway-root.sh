#!/bin/sh
# The t3code gateway's own root (ADR 0012; review 643-1), at "$1": node and the libraries it and
# setpriv load, setpriv, an empty /app for its bundle, and /state, owned by the gateway's uid (10120)
# alone. Nothing else of the container is in it. The Dockerfile builds it, and so does the test that
# runs the gateway's start chain (scripts/bundle-packaging.test.mjs).
set -eu
root="$1"
mkdir -p "$root/usr/local/bin" "$root/usr/bin" "$root/app" "$root/state"
cp /usr/local/bin/node "$root/usr/local/bin/node"
cp /usr/bin/setpriv "$root/usr/bin/setpriv"
for lib in $( (ldd /usr/local/bin/node; ldd /usr/bin/setpriv) | grep -oE '/[^ :]+\.so[^ :]*' | sort -u); do
  mkdir -p "$root$(dirname "$lib")"
  cp -L "$lib" "$root$lib"
done
chown 10120:10120 "$root/state"
chmod 0700 "$root/state"
