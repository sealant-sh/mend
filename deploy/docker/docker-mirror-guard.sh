#!/bin/sh
# Mend's Docker mirror guard (written by mend server setup): runs the registry, and keeps its cache
# under a byte cap and the disk it lives on above a floor. Over the cap, the cache is cleared and
# fills again from Docker Hub. Below the floor, the cache is cleared and the registry stays stopped
# until there is room again; meanwhile session Docker daemons pull from Docker Hub directly. The
# registry has no size cap of its own, and its seven-day expiry deletes layer data only.
set -u
root=/var/lib/registry
state=/tmp/mend-mirror-guard
size_mb() {
  case "$1" in
    *g) echo $((${1%g} * 1024)) ;;
    *m) echo "${1%m}" ;;
    *) echo "mend docker mirror guard: cannot read size $1" >&2 && exit 64 ;;
  esac
}
cap=$(size_mb "${DOCKER_MIRROR_MAX_SIZE:?}") || exit 64
floor=$(size_mb "${DOCKER_MIRROR_MIN_FREE:?}") || exit 64
interval=${DOCKER_MIRROR_GUARD_INTERVAL:-30}
pid=
stop_registry() {
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
  fi
  pid=
}
clear_cache() { rm -rf "$root/docker" "$root/scheduler-state.json"; }
cache_held() { [ -e "$root/docker" ] || [ -e "$root/scheduler-state.json" ]; }
trap 'stop_registry; exit 0' TERM INT
while :; do
  free=$(df -Pm "$root" | awk 'NR == 2 { print $4 }')
  if [ "$free" -lt "$floor" ]; then
    # Below the floor: no registry, and no cache, whether the registry was running or this is a
    # start with a cache left from before. Once the space is back, the next pass starts it again.
    stop_registry
    # What is left, looked at again after clearing: the log and the status say what this finds,
    # not what was attempted.
    if cache_held; then
      clear_cache
      if cache_held; then outcome="cache could not be cleared"; else outcome="cache cleared"; fi
      echo "mend docker mirror guard: ${free} MiB free on its disk, below ${floor} MiB: ${outcome}, registry paused" >&2
    fi
    if cache_held; then held=kept; else held=none; fi
    echo "paused ${free} ${floor} ${held}" >"$state"
  else
    used=$(du -sm "$root" | cut -f1)
    if [ "$used" -gt "$cap" ]; then
      stop_registry
      clear_cache
      if cache_held; then outcome="could not be cleared"; else outcome="cleared"; fi
      echo "mend docker mirror guard: cache ${used} MiB, over its ${cap} MiB cap: ${outcome}" >&2
    fi
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
      registry serve /etc/distribution/config.yml &
      pid=$!
    fi
    echo "running" >"$state"
  fi
  sleep "$interval" &
  wait $!
done
