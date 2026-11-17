#!/usr/bin/env bash
# Wait for the box and hold it the moment it is free (SKILL.md, step 3). No model calls: start it as
# background work and read its last line when it ends.
#
#   .agents/skills/box-main-run/wait-for-box.sh <deadline, epoch seconds>
#
# Every 2 minutes, while this machine's 1-minute load is at most 24: fetch main, check it out
# detached, and read `pnpm verify box plan --tag main-<sha12>`. When free, schema and disk all pass,
# take the hold at once with `verify box prepare`: other checks wait on the hold and take it within
# a minute of a release, so a slower reader loses the box. It ends with one line:
#
#   held <sha> <tag>            exit 0: the box is held for <tag>; prepare's result is in .verify/latest
#   deadline <what blocked>     exit 3: the deadline passed first
#   again <what blocked>        exit 4: 110 minutes passed (a background command's limit); start it again
#
# Run it from the worktree's root with MEND_VERIFY_BOX_SSH set. It never clears or takes another
# check's hold: `prepare` refuses while one is in force.
set -uo pipefail

deadline=${1:?usage: wait-for-box.sh <deadline, epoch seconds>}
[[ $deadline =~ ^[0-9]+$ ]] || { echo "usage: wait-for-box.sh <deadline, epoch seconds>" >&2; exit 2; }
: "${MEND_VERIFY_BOX_SSH:?set MEND_VERIFY_BOX_SSH}"

stop=$(( $(date +%s) + 110 * 60 ))
(( deadline < stop )) && stop=$deadline
reads=0
blocked="nothing read yet"

while (( $(date +%s) < stop )); do
  reads=$((reads + 1))
  load=$(cut -d' ' -f1 /proc/loadavg)
  if awk -v l="$load" 'BEGIN { exit !(l > 24) }'; then
    blocked="this machine's load ${load}"
  else
    git fetch --quiet origin main && git checkout --quiet --detach origin/main
    sha=$(git rev-parse HEAD)
    tag=main-${sha:0:12}
    timeout 120 pnpm -s verify box plan --tag "$tag" --json >/dev/null 2>&1
    blocked=$(jq -r '[.steps[] | select(.id != "deployed" and .status != "passed") | "\(.id): \(.detail)"] | join("; ")' \
      .verify/latest/box-plan.json 2>/dev/null || echo "the plan could not be read")
    if [[ -z $blocked ]]; then
      timeout 600 pnpm -s verify box prepare --tag "$tag" --yes --json >/dev/null 2>&1
      if jq -e '[.steps[] | select(.id != "deployed") | .status] | all(. == "passed")' \
        .verify/latest/box-prepare.json >/dev/null 2>&1; then
        echo "held $sha $tag"
        exit 0
      fi
      blocked="prepare refused: another check took the box first"
    fi
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
