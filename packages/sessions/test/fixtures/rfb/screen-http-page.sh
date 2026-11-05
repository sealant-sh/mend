#!/bin/sh
set -eu

# Consume the GET headers before replying. An eager `cat` closes its stdin while socat is still
# forwarding the request, so a broken pipe can cut the response short in Chromium.
cr=$(printf '\r')
while IFS= read -r header; do
  if [ "$header" = "$cr" ]; then
    printf 'HTTP/1.0 200 OK\r\nContent-Type: text/html\r\nContent-Length: %s\r\nConnection: close\r\n\r\n' "$(wc -c <"$1")"
    exec cat "$1"
  fi
done
