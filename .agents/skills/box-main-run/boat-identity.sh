#!/usr/bin/env bash
# Read one lane's Boat image identity lines before its copy goes (SKILL.md, steps 5 and 6; SLNT-1347).
#
#   .agents/skills/box-main-run/boat-identity.sh <lane> <out file>
#
# When sealant refuses a saved Boat image, its worker logs one line naming each field Boat changed:
#   Boat image identity differs: publication <id> quarantined (native-snapshot-identity-mismatch);
#   differences [{"field":…,"recorded":…,"boat":…}]
# The line lives only in the copy's container log: `vm save` does not keep it, and `vm down` deletes
# it. Its values are a snapshot name, a `bx_` VM id, a time and Boat's snapshot id, none a secret.
#
# Writes <out file> and prints it: a first line `boat-identity · lane <lane> · read <UTC> · found <n>`
# (or `none`), then each line as the log has it, with docker's timestamp in front. A copy whose log
# cannot be read prints `not read: …` and exits 1, so `none` is never claimed for a log not seen.
set -uo pipefail

lane=${1:?usage: boat-identity.sh <a|b|c> <out file>}
out=${2:?usage: boat-identity.sh <a|b|c> <out file>}
[[ $lane =~ ^[abc]$ ]] || { echo "boat-identity.sh: the lane is a, b or c" >&2; exit 2; }
box=$HOME/.local/state/mend-main-run/lanes/$lane/bin/box
[[ -x $box ]] || { echo "boat-identity.sh: no $box (step 4's names.sh writes it)" >&2; exit 2; }
mkdir -p "$(dirname "$out")"
at=$(date -u +%FT%TZ)

# The container must exist for `none` to mean anything: inspect first, then grep its whole log there.
if ! lines=$("$box" "docker container inspect mend-mend-1 >/dev/null && { docker logs --timestamps mend-mend-1 2>&1 | grep -F 'Boat image identity differs' || true; }" 2>&1); then
  printf 'boat-identity · lane %s · read %s · not read: %s\n' "$lane" "$at" "$(tail -1 <<<"$lines")" | tee "$out"
  exit 1
fi
if [[ -z $lines ]]; then
  printf 'boat-identity · lane %s · read %s · none\n' "$lane" "$at" | tee "$out"
else
  { printf 'boat-identity · lane %s · read %s · found %s\n' "$lane" "$at" "$(wc -l <<<"$lines" | tr -d ' ')"; printf '%s\n' "$lines"; } | tee "$out"
fi
