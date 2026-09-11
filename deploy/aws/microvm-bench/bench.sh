#!/usr/bin/env bash
# Git and dependency-install benchmark: the same operations on FSx (NFS) and on
# the VM's local disk, so the network filesystem tax is a number, not a feeling.
#
# Inputs (env):
#   BENCH_REPO        clone URL (default: the Mend monorepo)
#   BENCH_RUNS        repetitions per measurement (default 3)
#   BENCH_FSX_ROOT    mounted FSx root ("" skips the FSx half)
#   BENCH_LOCAL_ROOT  local scratch root
#   BENCH_INSTALL     "1" also times `pnpm install` (slow; needs internet)
#   BENCH_ID          identifier for this run
#
# Output: one JSON document on stdout. Progress goes to stderr.
set -euo pipefail

REPO="${BENCH_REPO:-https://github.com/sealant-sh/mend.git}"
RUNS="${BENCH_RUNS:-3}"
FSX_ROOT="${BENCH_FSX_ROOT:-}"
LOCAL_ROOT="${BENCH_LOCAL_ROOT:-/var/tmp/bench-local}"
INSTALL="${BENCH_INSTALL:-0}"
ID="${BENCH_ID:-$(date +%s)}"

log() { echo "bench: $*" >&2; }

# ms since epoch, monotonic enough for our purpose
now_ms() { date +%s%3N; }

# time_op <name> <cwd> <cmd...>: runs the command RUNS times, records each ms.
declare -A RESULTS
time_op() {
  local name="$1" cwd="$2"; shift 2
  local samples=()
  for ((i = 0; i < RUNS; i++)); do
    local t0 t1
    t0=$(now_ms)
    (cd "$cwd" && "$@" >/dev/null 2>&1) || { log "$name failed: $*"; samples+=(-1); continue; }
    t1=$(now_ms)
    samples+=($((t1 - t0)))
  done
  RESULTS["$name"]=$(IFS=,; echo "${samples[*]}")
  log "$name: ${RESULTS[$name]} ms"
}

drop_caches() {
  sync
  # Only works as root; on the VM we are root. Harmless otherwise.
  echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
}

# suite <label> <root>
suite() {
  local label="$1" root="$2"
  local base="$root/bench-$ID"
  rm -rf "$base"
  mkdir -p "$base"
  local bare="$base/repo.git" wt="$base/worktrees"

  log "[$label] clone --bare $REPO"
  local t0 t1
  t0=$(now_ms); git clone --bare --quiet "$REPO" "$bare"; t1=$(now_ms)
  RESULTS["$label.clone_bare"]=$((t1 - t0))

  local head
  head=$(git -C "$bare" rev-parse HEAD)
  mkdir -p "$wt"
  t0=$(now_ms); git -C "$bare" worktree add --quiet -b "bench/$ID" "$wt/a" "$head"; t1=$(now_ms)
  RESULTS["$label.worktree_add"]=$((t1 - t0))
  local a="$wt/a"

  drop_caches
  time_op "$label.status_cold" "$a" bash -c 'sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true; git status --porcelain'
  time_op "$label.status_warm" "$a" git status --porcelain
  echo "// bench $ID" >> "$a/README.md"
  time_op "$label.status_one_modified" "$a" git status --porcelain
  time_op "$label.diff" "$a" git diff
  time_op "$label.add" "$a" git add -A
  time_op "$label.commit" "$a" git -c commit.gpgsign=false commit --quiet -m "bench $ID" --allow-empty
  git -C "$a" checkout --quiet -b "bench/$ID-b"
  time_op "$label.switch" "$a" bash -c "git switch --quiet bench/$ID && git switch --quiet bench/$ID-b"
  time_op "$label.log" "$a" git log --oneline -200
  time_op "$label.worktree_add_more" "$bare" bash -c "git worktree add --quiet -b bench/$ID-\$RANDOM$RANDOM $wt/w\$RANDOM $head"
  time_op "$label.fetch_noop" "$a" git fetch --quiet origin
  time_op "$label.count_objects" "$bare" git count-objects -v
  time_op "$label.repack" "$bare" git repack -adq
  time_op "$label.gc" "$bare" git gc --quiet

  if [[ "$INSTALL" == "1" ]]; then
    if [[ -f "$a/pnpm-lock.yaml" ]]; then
      log "[$label] pnpm install"
      t0=$(now_ms)
      (cd "$a" && pnpm install --frozen-lockfile --reporter=silent >/dev/null 2>&1) || log "[$label] pnpm install failed"
      t1=$(now_ms)
      RESULTS["$label.pnpm_install"]=$((t1 - t0))
      time_op "$label.status_with_node_modules" "$a" git status --porcelain
    else
      log "[$label] no pnpm-lock.yaml, skipping install"
    fi
  fi

  # Sizes, for the storage line of the cost model.
  RESULTS["$label.repo_git_kib"]=$(du -sk "$bare" | cut -f1)
  RESULTS["$label.worktree_kib"]=$(du -sk "$a" | cut -f1)
}

if [[ -n "$FSX_ROOT" ]]; then
  suite fsx "$FSX_ROOT"
else
  log "no FSx root, skipping fsx suite"
fi
suite local "$LOCAL_ROOT"

# Emit JSON. Values are either a single number or a comma list of samples.
{
  echo "{"
  echo "  \"id\": \"$ID\", \"repo\": \"$REPO\", \"runs\": $RUNS, \"install\": $INSTALL,"
  echo "  \"mountOptions\": \"$(grep " $FSX_ROOT " /proc/self/mountinfo 2>/dev/null | head -1 | sed 's/.* - //')\","
  echo "  \"results\": {"
  first=1
  for k in $(printf '%s\n' "${!RESULTS[@]}" | sort); do
    v="${RESULTS[$k]}"
    [[ $first == 1 ]] || echo ","
    first=0
    if [[ "$v" == *,* ]]; then printf '    "%s": [%s]' "$k" "$v"; else printf '    "%s": %s' "$k" "$v"; fi
  done
  echo
  echo "  }"
  echo "}"
}
