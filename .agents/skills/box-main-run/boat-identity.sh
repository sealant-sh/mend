#!/usr/bin/env bash
# Read one lane's Boat image lines before its copy goes (SKILL.md, steps 5 and 6; SLNT-1347).
#
#   .agents/skills/box-main-run/boat-identity.sh <lane> <out file>
#
# sealant's worker logs one line for each saved Boat image it refuses or removes:
#   Boat image identity differs: publication <id> quarantined (native-snapshot-identity-mismatch);
#   differences [{"field":…,"recorded":…,"boat":…}]           Boat answered with another snapshot
#   Boat has no saved snapshot for image: publication <id> quarantined (native-publication-missing)
#                                                              Boat has none of that name
#   Boat images no workspace can use were removed { account, removed, kept }
#                                                              this copy's retention deleted some
# The lines live only in the copy's container log: `vm save` does not keep them, and `vm down`
# deletes them. Their values are ids, a snapshot name, a `bx_` VM id and times, none a secret.
#
# Writes <out file> and prints it: a first line
# `boat-identity · lane <lane> · read <UTC> · retention <off|on|none: no Boat> · found <n>` (or
# `none`), then each line as the log has it, with docker's timestamp in front. `retention off` is
# the copy's worker started with SEALANT_BOAT_IMAGE_GC_ENABLED=false (vm up --boat without
# --will-save). A copy whose
# log cannot be read prints `not read: …` and exits 1, so `none` is never claimed for a log not seen.
set -uo pipefail

lane=${1:?usage: boat-identity.sh <a|b|c> <out file>}
out=${2:?usage: boat-identity.sh <a|b|c> <out file>}
[[ $lane =~ ^[abc]$ ]] || { echo "boat-identity.sh: the lane is a, b or c" >&2; exit 2; }
box=$HOME/.local/state/mend-main-run/lanes/$lane/bin/box
[[ -x $box ]] || { echo "boat-identity.sh: no $box (step 4's names.sh writes it)" >&2; exit 2; }
mkdir -p "$(dirname "$out")"
at=$(date -u +%FT%TZ)

# The container must exist for `none` to mean anything: inspect first, then grep its whole log there.
if ! lines=$("$box" "docker container inspect mend-mend-1 >/dev/null && { docker logs --timestamps mend-mend-1 2>&1 | grep -F -e 'Boat image identity differs' -e 'Boat has no saved snapshot for image' -e 'Boat images no workspace can use were removed' || true; }" 2>&1); then
  printf 'boat-identity · lane %s · read %s · not read: %s\n' "$lane" "$at" "$(tail -1 <<<"$lines")" | tee "$out"
  exit 1
fi
# Only these two variables of the container's environment are read, never the rest: a worker with
# no Boat state directory launches no Boat VM and removes no Boat image.
env=$("$box" "docker container inspect -f '{{range .Config.Env}}{{println .}}{{end}}' mend-mend-1 | grep -E '^SEALANT_BOAT_(IMAGE_GC_ENABLED|STATE_DIRECTORY)=' || true" 2>/dev/null)
if ! grep -q '^SEALANT_BOAT_STATE_DIRECTORY=.' <<<"$env"; then
  retention="none: no Boat"
elif grep -qx 'SEALANT_BOAT_IMAGE_GC_ENABLED=false' <<<"$env"; then
  retention=off
else
  retention=on
fi
if [[ -z $lines ]]; then
  printf 'boat-identity · lane %s · read %s · retention %s · none\n' "$lane" "$at" "$retention" | tee "$out"
else
  { printf 'boat-identity · lane %s · read %s · retention %s · found %s\n' "$lane" "$at" "$retention" "$(wc -l <<<"$lines" | tr -d ' ')"; printf '%s\n' "$lines"; } | tee "$out"
fi
