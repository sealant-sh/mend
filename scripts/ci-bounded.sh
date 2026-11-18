#!/usr/bin/env bash
# Run one CI step that waits on the network (an apt mirror, a browser download) so that a stall
# fails in minutes: an attempt that prints nothing for MINUTES has stalled, and is stopped and tried
# again, up to ATTEMPTS times. Each stall says so in the job's log instead of holding the job until
# its own limit (SLNT-1076: `playwright-core install --with-deps` sat in apt-get update for two
# hours).
#
#   scripts/ci-bounded.sh "<what, for the log>" <minutes> <attempts> -- <command> [args...]
#
# The bound is on silence, not on the attempt's length, because a slow mirror is not a stalled one:
# apt-get prints a line per package and playwright-core one per tenth of a browser, and at 130 kB/s
# both kept printing past four minutes until a wall-clock bound failed all three tries (SLNT-1096).
# A command that keeps printing runs until it ends or the job's own time limit stops it.
#
# The stop goes to the command's whole process group, through timeout, so a stall in a grandchild
# ends with it, but only for processes this user may signal. Run a command that elevates
# (playwright-core's install-deps runs `sudo apt-get`) under `sudo scripts/ci-bounded.sh`:
# otherwise the root apt-get outlives its attempt, keeps the dpkg lock, and every retry fails on it
# (SLNT-1094).
# Exits 0 on the first attempt that succeeds, 1 otherwise.
set -u

if [ "$#" -lt 5 ] || [ "$4" != "--" ]; then
  echo "usage: $0 <what> <minutes> <attempts> -- <command> [args...]" >&2
  exit 2
fi
what=$1
minutes=$2
attempts=$3
shift 4
seconds=$(awk -v minutes="$minutes" 'BEGIN { print minutes * 60 }')

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  # One pipe per attempt, so nothing a stopped attempt left behind can write into the next one's.
  output="$scratch/output-$attempt"
  mkfifo "$output"
  # timeout with no duration of its own: it leads the command's process group and passes the TERM
  # below to all of it, then KILL 30 s later if anything ignored it.
  timeout --kill-after=30s 0 "$@" >"$output" 2>&1 &
  command=$!
  stalled=false
  while :; do
    IFS= read -r -t "$seconds" line
    read_status=$?
    if [ "$read_status" -eq 0 ]; then
      printf '%s\n' "$line"
      continue
    fi
    # Over 128: nothing arrived for the bound. Otherwise the output ended, maybe mid-line.
    if [ "$read_status" -gt 128 ]; then
      [ -n "$line" ] && printf '%s\n' "$line"
      # A command that has exited may leave a grandchild holding its output open: that is not a stall.
      if kill -0 "$command" 2>/dev/null; then
        stalled=true
        kill -TERM "$command"
      fi
    elif [ -n "$line" ]; then
      printf '%s\n' "$line"
    fi
    break
  done <"$output"
  wait "$command"
  status=$?
  if [ "$stalled" = true ]; then
    echo "::warning::${what} stalled: it printed nothing for ${minutes} minutes (attempt ${attempt} of ${attempts})"
  elif [ "$status" -eq 0 ]; then
    exit 0
  else
    echo "::warning::${what} failed with exit code ${status} (attempt ${attempt} of ${attempts})"
  fi
done
echo "::error::${what} did not finish in ${attempts} attempts; the warnings above say whether each stalled or failed"
exit 1
