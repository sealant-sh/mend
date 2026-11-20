#!/usr/bin/env bash
# Wait for the box and hold it the moment it is free (SKILL.md, step 3). No model calls: start it as
# background work and read its last line when it ends.
#
#   .agents/skills/box-main-run/wait-for-box.sh <deadline, epoch seconds>
#
# Every 2 minutes, while this machine's 1-minute load is at most 24: fetch main, check it out
# detached, and read `pnpm verify box plan --tag main-<sha12> --load <the run's data>`. When free,
# schema and disk all pass, and nobody has used the box for an hour (no session started or settled,
# and no workspace container started, in the last 60 minutes: the owner uses this server by hand),
# take the hold at once with `verify box prepare --load`, which dumps the box's data and loads the
# run's own in its place: other checks wait on the hold and take it within a minute of a release,
# so a slower reader loses the box. It ends with one line:
#
#   held <sha> <tag>            exit 0: the box is held for <tag>; prepare's result is in .verify/latest
#   deadline <what blocked>     exit 3: the deadline passed first
#   again <what blocked>        exit 4: 110 minutes passed (a background command's limit); start it again
#   failed <what failed>        exit 5: the box is held for this run, but loading its data failed;
#                               SKILL.md, step 3, says what to do
#
# Run it from the worktree's root with MEND_VERIFY_BOX_SSH set. It never clears or takes another
# check's hold: `prepare` refuses while one is in force.
set -uo pipefail

deadline=${1:?usage: wait-for-box.sh <deadline, epoch seconds>}
[[ $deadline =~ ^[0-9]+$ ]] || { echo "usage: wait-for-box.sh <deadline, epoch seconds>" >&2; exit 2; }
: "${MEND_VERIFY_BOX_SSH:?set MEND_VERIFY_BOX_SSH}"

WORLD=/root/main-run/world.sql   # the run's own data, saved by each run's release (SKILL.md, step 6)
read -r -a box_ssh <<<"$MEND_VERIFY_BOX_SSH"

# Minutes since anyone last used the box: the newest session start or settle in its data, and the
# newest workspace container. Empty when it cannot be read.
idle_minutes() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 "${box_ssh[@]}" 'bash -s' <<'READ' 2>/dev/null
set -u
now=$(date +%s)
newest=$(docker exec mend-postgres-1 psql -U postgres -d mend -At -c \
  "select coalesce(extract(epoch from greatest(max(created_at), max(settled_at)))::bigint, 0) from agent_sessions") || exit 1
for c in $(docker ps --filter name=^sealant- --format '{{.CreatedAt}}' | cut -d' ' -f1,2); do
  t=$(date -d "$c" +%s 2>/dev/null) && [ "$t" -gt "$newest" ] && newest=$t
done
echo $(( (now - newest) / 60 ))
READ
}

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
    timeout 120 pnpm -s verify box plan --tag "$tag" --load "$WORLD" --json >/dev/null 2>&1
    blocked=$(jq -r '[.steps[] | select(.id != "deployed" and .status != "passed") | "\(.id): \(.detail)"] | join("; ")' \
      .verify/latest/box-plan.json 2>/dev/null || echo "the plan could not be read")
    if [[ -z $blocked ]]; then
      idle=$(idle_minutes)
      if [[ ! $idle =~ ^[0-9]+$ ]]; then
        blocked="the box's last use could not be read"
      elif (( idle < 60 )); then
        blocked="someone used the box ${idle} min ago"
      fi
    fi
    if [[ -z $blocked ]]; then
      timeout 1200 pnpm -s verify box prepare --tag "$tag" --load "$WORLD" --yes --json >/dev/null 2>&1
      if jq -e '[.steps[] | select(.id != "deployed") | .status] | all(. == "passed")' \
        .verify/latest/box-prepare.json >/dev/null 2>&1; then
        echo "held $sha $tag"
        exit 0
      fi
      blocked="prepare refused: $(jq -r '[.steps[] | select(.id != "deployed" and .status != "passed") | "\(.id): \(.detail)"] | join("; ")' \
        .verify/latest/box-prepare.json 2>/dev/null || echo "its result could not be read")"
      # A hold this run took and a load that failed are not a busy box: say so and stop waiting.
      if jq -e '[.steps[] | select(.id == "dump" and .status == "passed")] | length > 0' \
        .verify/latest/box-prepare.json >/dev/null 2>&1; then
        echo "failed ${blocked}"
        exit 5
      fi
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
