#!/usr/bin/env bash
# Run one CI step that waits on the network (an apt mirror, a browser download) within a bound:
# each attempt gets MINUTES, a stalled or failed attempt is tried again up to ATTEMPTS times, and
# each stall says so in the job's log instead of holding the job until its own limit (SLNT-1076:
# `playwright-core install --with-deps` sat in apt-get update for two hours).
#
#   scripts/ci-bounded.sh "<what, for the log>" <minutes> <attempts> -- <command> [args...]
#
# timeout signals the command's whole process group, so a stall in a grandchild (sudo apt-get
# under playwright-core) ends with it. Exits 0 on the first attempt that succeeds, 1 otherwise.
set -u

if [ "$#" -lt 5 ] || [ "$4" != "--" ]; then
  echo "usage: $0 <what> <minutes> <attempts> -- <command> [args...]" >&2
  exit 2
fi
what=$1
minutes=$2
attempts=$3
shift 4

for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  timeout --kill-after=30s "${minutes}m" "$@"
  status=$?
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  # 124: timeout stopped it with TERM; 137: it ignored TERM and was killed 30 s later.
  if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
    echo "::warning::${what} stalled: it did not finish within ${minutes} minutes (attempt ${attempt} of ${attempts})"
  else
    echo "::warning::${what} failed with exit code ${status} (attempt ${attempt} of ${attempts})"
  fi
done
echo "::error::${what} did not finish in ${attempts} attempts of ${minutes} minutes each; the warnings above say whether each stalled or failed"
exit 1
