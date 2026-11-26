#!/usr/bin/env bash
# Wait for room on this machine and boot the run's check VM copies, one per lane (SKILL.md, step 3).
# No model calls: start it as background work and read its last line when it ends.
#
#   .agents/skills/box-main-run/copies.sh <deadline, epoch seconds> <Boat copies>
#
# <Boat copies> is SKILL.md's BOAT_COPIES. Lane A always comes first and gets Boat when it is 1 or
# more; lane C gets Boat too when it is 2 or more; lane B never needs it. Every 2 minutes, while this
# machine's 1-minute load is at most 24 and fewer than MAX_COPIES (5) copies run here, counting other
# checks' copies, it boots the next lane's copy with `pnpm verify vm up [--boat]`. The run takes at
# most 3. Lane A waits up to 60 minutes for Boat while `vm up --boat` refuses (every Boat slot is
# held by other checks: SLNT-1218), then boots without it. Lane C does not wait: with every Boat
# slot held it boots without Boat at once, and group 9's Boat flows run on lane A. Lanes B and C
# boot only while there is room for them; a lane with no room by the time lane A is up is left out,
# and its groups run on lane A (SKILL.md, Lanes).
#
# Every copy reports to this machine's Sentry projects when ~/.local/share/sentry-mend/verify.env
# names them (SLNT-1383): `vm up` hands MEND_VERIFY_SENTRY_DSN, MEND_VERIFY_SEALANT_SENTRY_DSN,
# MEND_VERIFY_SEALANTD_SENTRY_DSN (SLNT-1358) and MEND_VERIFY_SENTRY_BROWSER_DSN to the copy's
# `mend server setup` under the environment `check-vm`.
# Another agent wrote that file, so it is read as data, never run: only those four names, each
# value taken only when it has a DSN's shape. A missing file, or one without them, leaves telemetry
# off and the copies boot as before. No value is printed: the lane's line says only whether `vm up`'s
# telemetry step passed. Its setting lives in the copy's server.env, which `vm save` does not keep.
#
# For each lane it boots, it writes ~/.local/state/mend-main-run/lanes/<lane>/copy.json (vm up's
# copy: slot, url, ssh, startedAt, boat) and prints
# `lane <lane> · copy <slot> · <url> · boat|no Boat · telemetry <passed|skipped|off>`.
# It ends with one line:
#
#   copies a=<slot> [b=<slot>] [c=<slot>]   exit 0: lane A is up, with whichever others had room
#   deadline <what blocked>                exit 3: the deadline passed before lane A was up
#   again <what blocked>                   exit 4: 110 minutes passed (a background command's limit);
#                                          start it again: lanes already up are kept and not booted again
#   failed <lane> <what failed>            exit 5: vm up failed for a reason other than room
#
# Run it from the worktree's root.
set -uo pipefail

deadline=${1:?usage: copies.sh <deadline, epoch seconds> <Boat copies>}
boat=${2:?usage: copies.sh <deadline, epoch seconds> <Boat copies>}
[[ $deadline =~ ^[0-9]+$ && $boat =~ ^[0-9]+$ ]] || { echo "usage: copies.sh <deadline, epoch seconds> <Boat copies>" >&2; exit 2; }
MAX_COPIES=5
LANES=$HOME/.local/state/mend-main-run/lanes
mkdir -p "$LANES"

# The DSNs, as NAME=value words for `env`, from the file's `[export ]NAME=value` lines.
TELEMETRY_FILE=${MAIN_RUN_TELEMETRY_FILE:-$HOME/.local/share/sentry-mend/verify.env}
telemetry=()
if [[ -f $TELEMETRY_FILE && -r $TELEMETRY_FILE ]]; then
  for var in MEND_VERIFY_SENTRY_DSN MEND_VERIFY_SEALANT_SENTRY_DSN MEND_VERIFY_SEALANTD_SENTRY_DSN MEND_VERIFY_SENTRY_BROWSER_DSN; do
    value=$(sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?${var}=//p" "$TELEMETRY_FILE" | tail -n 1)
    value=${value%$'\r'}
    if [[ $value =~ ^\"(.*)\"$ || $value =~ ^\'(.*)\'$ ]]; then value=${BASH_REMATCH[1]}; fi
    [[ $value =~ ^https://[A-Za-z0-9]+@[A-Za-z0-9.-]+(:[0-9]+)?/[0-9]+$ ]] && telemetry+=("$var=$value")
  done
fi
unset value

stop=$(( $(date +%s) + 110 * 60 ))
(( deadline < stop )) && stop=$deadline
boat_since=
blocked="nothing read yet"
reads=0

running() { pnpm -s verify vm list --json 2>/dev/null | jq '[.copies[] | select(.running)] | length'; }
# A lane is up when its copy.json names a slot that runs now. One whose copy is gone (an earlier
# run's) is forgotten, so its lane boots again.
up_lane() {
  local slot
  slot=$(jq -r '.slot // empty' "$LANES/$1/copy.json" 2>/dev/null) || return 1
  [[ -n $slot ]] || return 1
  if pnpm -s verify vm list --json 2>/dev/null | jq -e --argjson s "$slot" '.copies[] | select(.slot == $s and .running)' >/dev/null; then
    return 0
  fi
  rm -f "$LANES/$1/copy.json"
  return 1
}

# up <lane> <with boat 0|1>: boots one copy; 0 booted, 1 refused for Boat, 2 failed.
up() {
  local lane=$1 with=$2 out flags=(--json) at
  ((with)) && flags+=(--boat)
  # Lane A's data is saved, so its save records each Boat image it removes; every other copy
  # removes none (SLNT-1347).
  ((with)) && [[ $lane == a ]] && flags+=(--will-save)
  at=$(date -u +%FT%TZ)
  out=$(env "${telemetry[@]}" pnpm -s verify vm up "${flags[@]}" 2>/dev/null)
  if jq -e '.status == "passed" and .copy.slot != null' <<<"$out" >/dev/null 2>&1; then
    mkdir -p "$LANES/$lane"
    jq --argjson boat "$with" --arg at "$at" '.copy + { startedAt: $at, boat: ($boat == 1) }' <<<"$out" >"$LANES/$lane/copy.json"
    echo "lane $lane · copy $(jq -r .copy.slot <<<"$out") · $(jq -r .copy.url <<<"$out") · $( ((with)) && echo boat || echo 'no Boat') · telemetry $(jq -r '[.steps[]? | select(.id == "telemetry") | .status][0] // "off"' <<<"$out")"
    return 0
  fi
  if ((with)) && jq -e '.steps[] | select(.id == "boat" and .status == "blocked_by_prerequisite")' <<<"$out" >/dev/null 2>&1; then
    blocked="Boat: $(jq -r '.steps[] | select(.id == "boat") | .detail' <<<"$out")"
    return 1
  fi
  # A copy whose start failed is removed, so it never holds a slot.
  slot=$(jq -r '.copy.slot // empty' <<<"$out" 2>/dev/null)
  [[ -n $slot ]] && pnpm -s verify vm down "$slot" >/dev/null 2>&1
  blocked="vm up: $(jq -r '[.steps[]? | select(.status != "passed") | "\(.id): \(.detail)"] | join("; ")' <<<"$out" 2>/dev/null || echo "no result")"
  return 2
}

while (( $(date +%s) < stop )); do
  reads=$((reads + 1))
  load=$(cut -d' ' -f1 /proc/loadavg)
  live=$(running)
  if awk -v l="$load" 'BEGIN { exit !(l > 24) }'; then
    blocked="this machine's load ${load}"
  elif [[ ! $live =~ ^[0-9]+$ ]]; then
    blocked="vm list could not be read"
  elif (( live >= MAX_COPIES )); then
    blocked="${live} copies run on this machine"
  elif ! up_lane a; then
    with=0
    if (( boat >= 1 )); then
      [[ -z $boat_since ]] && boat_since=$(date +%s)
      (( $(date +%s) - boat_since < 3600 )) && with=1
    fi
    up a "$with"
    case $? in
      0) continue ;;
      1) ;;
      2) echo "failed a ${blocked}"; exit 5 ;;
    esac
  else
    for lane in b c; do
      up_lane "$lane" && continue
      live=$(running)
      [[ $live =~ ^[0-9]+$ ]] && (( live < MAX_COPIES )) || break
      with=0
      [[ $lane == c ]] && (( boat >= 2 )) && with=1
      up "$lane" "$with"
      rc=$?
      if (( rc == 1 )); then
        # Every Boat slot is held by other checks. Lane C boots without Boat rather than wait: group
        # 9's Boat flows then run on lane A (SKILL.md, Lanes).
        echo "lane $lane · no Boat slot free · ${blocked}"
        up "$lane" 0
        rc=$?
      fi
      (( rc == 2 )) && echo "lane $lane · not booted · ${blocked}"
    done
    line="copies a=$(jq -r .slot "$LANES/a/copy.json")"
    for lane in b c; do up_lane "$lane" && line+=" $lane=$(jq -r .slot "$LANES/$lane/copy.json")"; done
    echo "$line"
    exit 0
  fi
  (( reads % 15 == 1 )) && echo "$(date -u +%FT%TZ) waiting · ${blocked}"
  sleep 120
done

if (( $(date +%s) >= deadline )); then
  echo "deadline ${blocked}"
  exit 3
fi
echo "again ${blocked}"
exit 4
