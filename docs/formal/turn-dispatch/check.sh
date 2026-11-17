#!/usr/bin/env bash
# Model-checks TurnDispatch.tla with TLC or tlx (README.md beside this file says what it checks).
#
#   check.sh                every row of ROWS at the full bounds; exits 0 only when each row ends
#                           with the verdict and the distinct-state count ROWS pins
#   check.sh --quick        the same with one message instead of two: seconds, for pull requests
#   check.sh <row>          one row, printing the checker's whole output and its trace
#   check.sh --engine tlc   any of the above with TLC instead of tlx (MEND_FORMAL_ENGINE=tlc too)
#
# A row expected to hold uses every core; MEND_FORMAL_WORKERS caps that on a shared machine.
#
# The checker is tlx (github.com/tlaplus-x/tlx, version 0.1), a TLA+ model checker in Rust that
# reads the same files as TLC. ../tlx.sh builds it once at the commit Mend pins, and check.sh runs
# that build, or the binary in MEND_TLX when that is set. It runs with -tlc, so its verdicts,
# counts and traces are TLC's.
#
# TLC stays for a cross-check by hand; nothing scheduled runs it. It is tla2tools 1.7.4 (TLC 2.19),
# checked against its sha256 before it runs. It comes from the repository's pinned nixpkgs when
# Nix is installed, else from the GitHub release (needs java and curl), or from TLA2TOOLS_JAR.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel)

TLA2TOOLS_VERSION=1.7.4
TLA2TOOLS_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88

# row | mutants | invariant | action constraint | expected outcome | distinct states | at --quick
#
# Rows named `code-*` are the code. Three of them are expected to be violated, and each is a
# finding README.md tells as steps: `code-at-most-once` (SLNT-1022), `code-stopped-never-starts`
# (SLNT-1021) and `code-completed-only-if-taken` with `code-timeout-slnt-466` (SLNT-466).
# Each finding has a row that holds once the schedule it needs is taken away (an action constraint
# from MCTurnDispatch.tla) or once the code is changed the way its ticket suggests (`fix-sketch-*`),
# so each property is shown to hold somewhere. Each `mutant-*` row breaks one check or one order of
# the code where its property holds, so each property is shown to fail.
#
# The last two fields pin the distinct states the checker finds at the full bounds and at --quick's.
# A row is as expected only when its verdict and its count both match, so a checker that says
# "holds" over a different state space fails the run. A row that holds explores every reachable
# state; a row expected to fail runs on one worker and stops at the same shortest trace every time.
# When a change to the model moves a count, take the new one from a run of this script, full and
# --quick. tlx and TLC reached every count here alike (README.md, "tlx and TLC").
ROWS=(
  "code-at-most-once|{}|AtMostOnce||violated AtMostOnce|45175|18663"
  "code-at-most-once-no-retry|{}|AtMostOnce|NoRetry|holds|686605|32583"
  "mutant-putback-uncertain|{\"putback-uncertain\"}|AtMostOnce|NoRetry|violated AtMostOnce|49785|19625"
  "code-stopped-never-starts|{}|StoppedNeverStarts||violated StoppedNeverStarts|178|129"
  "fix-sketch-atomic-stop|{\"stop-atomic\"}|StoppedNeverStarts||holds|16187486|392855"
  "mutant-write-after-close|{\"stop-atomic\", \"write-after-close\"}|StoppedNeverStarts||violated StoppedNeverStarts|230|154"
  "code-completed-only-if-taken|{}|CompletedOnlyIfTaken||violated CompletedOnlyIfTaken|6409|3208"
  "code-timeout-slnt-466|{}|CompletedOnlyIfTaken|NoRestartNoRetry|violated CompletedOnlyIfTaken|4126|2327"
  "code-no-other-turn-seen-in-send|{}|CompletedOnlyIfTaken|NoOtherTurnSeenDuringSend|holds|17030751|659645"
  "fix-sketch-slnt-466|{\"answer-binds-only\"}|CompletedOnlyIfTaken||holds|24417284|782585"
  "mutant-end-to-claim|{\"end-to-claim\"}|CompletedOnlyIfTaken|NoOtherTurnSeenDuringSend|violated CompletedOnlyIfTaken|1440|829"
)

# The help is the comment block at the top of this file.
usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }

turns="{t1, t2}"
own="{o1}"
quick=0
only=""
engine=${MEND_FORMAL_ENGINE:-tlx}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick) quick=1 ;;
    --engine)
      [[ $# -ge 2 ]] || { echo "check.sh: --engine needs tlc or tlx" >&2; exit 2; }
      engine=$2
      shift
      ;;
    --engine=*) engine=${1#--engine=} ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "check.sh: unknown option $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      [[ -z "$only" ]] || { echo "check.sh: one row at a time ($only, $1)" >&2; exit 2; }
      only=$1
      ;;
  esac
  shift
done
[[ $quick -eq 1 ]] && turns="{t1}"
case "$engine" in
  tlc | tlx) ;;
  *)
    echo "check.sh: unknown engine $engine; it is tlc or tlx" >&2
    exit 2
    ;;
esac

scratch=$(mktemp -d -t turn-dispatch.XXXXXX)
trap 'rm -rf -- "$scratch"' EXIT

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

if [[ "$engine" == tlx ]]; then
  # The pinned build, which ../tlx.sh builds once; MEND_TLX names another, to compare by hand.
  if [[ -n "${MEND_TLX:-}" ]]; then
    tlx=$MEND_TLX
    if [[ ! -x "$tlx" ]]; then
      echo "check.sh: MEND_TLX is $MEND_TLX, which is not an executable; nothing was checked." >&2
      exit 2
    fi
  elif ! tlx=$(bash "$here/../tlx.sh"); then
    echo "check.sh: no tlx, and ../tlx.sh could not build it (above); nothing was checked." >&2
    exit 2
  fi
  # tlx has no version flag; it prints the version first even for a file it cannot read.
  version=$("$tlx" check "$scratch/none.tla" 2>&1 | sed -n 's/^tlx version //p' | head -1 || true)
  header="tlx ${version:-(version unknown)} ($tlx)"
  # -tlc: TLC's verdicts, counts, depth and shortest traces, which ROWS pins.
  checker=("$tlx" check -tlc)
else
  # The TLC command, as an array.
  if [[ -n "${TLA2TOOLS_JAR:-}" ]]; then
    jar=$TLA2TOOLS_JAR
    tlc=(java -XX:+UseParallelGC -cp "$jar" tlc2.TLC)
  elif command -v nix >/dev/null; then
    out=$(nix build --no-link --print-out-paths --inputs-from "$root" nixpkgs#tlaplus \
      2> >(grep -v "Git tree '.*' is dirty" >&2))
    jar="$out/share/java/tla2tools.jar"
    tlc=("$out/bin/tlc")
  else
    cache="${XDG_CACHE_HOME:-$HOME/.cache}/mend-formal"
    jar="$cache/tla2tools-$TLA2TOOLS_VERSION.jar"
    if [[ ! -f "$jar" ]]; then
      mkdir -p "$cache"
      curl -fsSL -o "$jar.part" \
        "https://github.com/tlaplus/tlaplus/releases/download/v$TLA2TOOLS_VERSION/tla2tools.jar"
      mv "$jar.part" "$jar"
    fi
    tlc=(java -XX:+UseParallelGC -cp "$jar" tlc2.TLC)
  fi
  if [[ "$(sha256_of "$jar")" != "$TLA2TOOLS_SHA256" ]]; then
    echo "check.sh: $jar is not tla2tools $TLA2TOOLS_VERSION (sha256 differs); nothing was checked" >&2
    exit 2
  fi
  # TLC writes its standard modules into java.io.tmpdir: keep them in this run's scratch directory.
  # The heap may take three quarters of the machine: Java's default quarter left TLC spilling its
  # fingerprint set to disk on CI's 16 GB runner at standby-discard's 129 million states.
  export JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=$scratch -XX:MaxRAMPercentage=75.0"

  header="TLC (tla2tools $TLA2TOOLS_VERSION)"
  checker=("${tlc[@]}" -difftrace)
fi

# With MEND_FORMAL_PROGRESS set (CI sets it), the checker's memory line and its progress lines
# reach stderr as they come, so a run stopped by its time budget shows how far it got and how fast.
progress() {
  if [[ -n "${MEND_FORMAL_PROGRESS:-}" ]]; then
    grep --line-buffered -E '^(Progress|Running|Starting|Finished)' | sed -u "s/^/  $1: /" >&2
  else
    cat >/dev/null
  fi
}

run_row() {
  local name=$1 mutant=$2 invariants=$3 constraint=$4 expected=$5 pinned=$6
  local cfg="$scratch/$name.cfg" log="$scratch/$name.out"
  {
    echo "CONSTANTS"
    echo "  Turns = $turns"
    echo "  OwnTurns = $own"
    echo "  NoId = NoId"
    echo "  Mutants = $mutant"
    echo "SPECIFICATION Spec"
    echo "INVARIANT TypeOK"
    for inv in $invariants; do echo "INVARIANT $inv"; done
    [[ -n "$constraint" ]] && echo "ACTION_CONSTRAINT $constraint"
    echo "SYMMETRY Symmetry"
    echo "CHECK_DEADLOCK FALSE"
  } >"$cfg"
  # A row expected to fail runs on one worker, so the breadth-first search stops at the same
  # shortest trace and the same count every time; a row expected to hold uses every core.
  local workers=${MEND_FORMAL_WORKERS:-auto}
  [[ "$expected" == holds ]] || workers=1
  local started=$SECONDS
  (cd "$here" && "${checker[@]}" -workers "$workers" -config "$cfg" \
    -metadir "$scratch/meta-$name" MCTurnDispatch.tla) 2>&1 \
    | grep --line-buffered -v '^Picked up JAVA_TOOL_OPTIONS' | tee "$log" | progress "$name" || true
  local seconds=$((SECONDS - started))
  local observed
  if grep -q '^Model checking completed. No error has been found.' "$log"; then
    observed="holds"
  elif violated=$(grep -o '^Error: Invariant [A-Za-z]* is violated' "$log" | head -1) && [[ -n "$violated" ]]; then
    observed="violated $(echo "$violated" | cut -d' ' -f3)"
  else
    observed="error"
  fi
  local states
  states=$(grep -o '[0-9,]* distinct states found' "$log" | tail -1 | cut -d' ' -f1 | tr -d ,)
  local verdict="as expected"
  if [[ "$observed" != "$expected" ]]; then
    verdict="NOT AS EXPECTED"
  elif [[ "${states:-?}" != "$pinned" ]]; then
    verdict="NOT AS EXPECTED: ROWS pins $pinned states"
  fi
  printf '%-30s %-38s %-38s %12s %5ss  %s\n' "$name" "expected: $expected" "observed: $observed" \
    "${states:-?}" "$seconds" "$verdict"
  if [[ -n "$only" || "$verdict" != "as expected" ]]; then
    echo "----- $engine output for $name -----"
    cat "$log"
    echo "----- end of $name -----"
  fi
  [[ "$verdict" == "as expected" ]]
}

echo "$header · Turns = $turns · OwnTurns = $own · $(git -C "$root" rev-parse --short HEAD)"
failed=0
matched=0
for row in "${ROWS[@]}"; do
  IFS='|' read -r name mutant invariants constraint expected full_states quick_states <<<"$row"
  [[ -n "$only" && "$name" != "$only" ]] && continue
  matched=1
  pinned=$full_states
  [[ $quick -eq 1 ]] && pinned=$quick_states
  run_row "$name" "$mutant" "$invariants" "$constraint" "$expected" "$pinned" || failed=1
done
if [[ $matched -eq 0 ]]; then
  echo "check.sh: no row named $only; rows are:" >&2
  for row in "${ROWS[@]}"; do echo "  ${row%%|*}" >&2; done
  exit 2
fi
exit $failed
