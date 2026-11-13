#!/usr/bin/env bash
# Model-checks StandbyDiscard.tla with TLC or tlx (README.md beside this file says what it checks).
#
#   check.sh                every row of ROWS at the full bounds; exits 0 only when each row ends
#                           with the verdict and the distinct-state count ROWS pins
#   check.sh --quick        the same with one launch instead of two: seconds, for iterating
#   check.sh <row>          one row, printing the checker's whole output and its trace
#   check.sh --engine tlx   any of the above with tlx instead of TLC (MEND_FORMAL_ENGINE=tlx too)
#
# TLC is the reference: the run that goes with a change to the model or to the code it models uses
# TLC. It is tla2tools 1.7.4 (TLC 2.19), checked against its sha256 before it runs. It comes from
# the repository's pinned nixpkgs when Nix is installed, else from the GitHub release (needs java
# and curl), or from TLA2TOOLS_JAR when that is set.
#
# tlx (github.com/tlaplus-x/tlx, version 0.1) is for iterating: about twelve times faster here.
# It is the binary in MEND_TLX when that is set, else `tlx` on PATH. It runs with -tlc, so its
# verdicts, counts and traces are TLC's; trace.py reads either checker's trace.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel)

TLA2TOOLS_VERSION=1.7.4
TLA2TOOLS_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88

# row | mutant | invariants | action constraint | expected outcome | distinct states | at --quick
#
# The code rows hold. Each mutant breaks one check or one order of the code, so a row expected to
# fail shows that its property can fail. `no-reread` is the drain as it was before SLNT-823 (the
# finding in README.md); its two restricted rows say what that finding needed.
#
# The last two fields pin the distinct states TLC finds at the full bounds and at --quick's. A row
# is as expected only when its verdict and its count both match, so a checker that says "holds"
# over a different state space fails the run. A row that holds explores every reachable state; a
# row expected to fail runs on one worker and stops at the same shortest trace every time. When a
# change to the model moves a count, take the new one from a TLC run.
ROWS=(
  "code-promise|none|NoDiscardOfSessionWork||holds|18141305|421021"
  "code-promise-atomic-retire|none|NoDiscardOfSessionWork|RetireIsAtomic|holds|13959504|354953"
  "code-claimable|none|NoClaimableRowWithSession||holds|18141305|421021"
  "mutant-no-reread|no-reread|NoDiscardOfSessionWork||violated NoDiscardOfSessionWork|113052|31106"
  "mutant-no-reread-atomic-retire|no-reread|NoDiscardOfSessionWork|RetireIsAtomic|violated NoDiscardOfSessionWork|104484|28637"
  "mutant-no-reread-no-sweep|no-reread|NoDiscardOfSessionWork|NoSweep|holds|293226|20238"
  "mutant-reread-before-retire|reread-before-retire|NoDiscardOfSessionWork||violated NoDiscardOfSessionWork|166239|42735"
  "mutant-discard-before-retire|discard-before-retire|NoDiscardOfSessionWork||violated NoDiscardOfSessionWork|4509|2136"
  "mutant-claim-leaves-ready|claim-leaves-ready|NoClaimableRowWithSession||violated NoClaimableRowWithSession|188|125"
  "mutant-reused-id|reused-id|NoClaimableRowWithSession||violated NoClaimableRowWithSession|9408|3926"
)

# The help is the comment block at the top of this file.
usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }

standbys="{s1, s2}"
launches="{l1, l2}"
quick=0
only=""
engine=${MEND_FORMAL_ENGINE:-tlc}
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
[[ $quick -eq 1 ]] && launches="{l1}"
case "$engine" in
  tlc | tlx) ;;
  *)
    echo "check.sh: unknown engine $engine; it is tlc or tlx" >&2
    exit 2
    ;;
esac

scratch=$(mktemp -d -t standby-discard.XXXXXX)
trap 'rm -rf -- "$scratch"' EXIT

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

if [[ "$engine" == tlx ]]; then
  tlx=${MEND_TLX:-$(command -v tlx || true)}
  if [[ -z "$tlx" || ! -x "$tlx" ]]; then
    if [[ -n "${MEND_TLX:-}" ]]; then
      echo "check.sh: MEND_TLX is $MEND_TLX, which is not an executable; nothing was checked." >&2
    else
      echo "check.sh: no tlx on PATH and MEND_TLX is not set; nothing was checked." >&2
    fi
    echo "  Build it as README.md says, then set MEND_TLX to it, or run with TLC (the default)." >&2
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
  export JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=$scratch"

  header="TLC (tla2tools $TLA2TOOLS_VERSION)"
  checker=("${tlc[@]}" -difftrace)
fi

run_row() {
  local name=$1 mutant=$2 invariants=$3 constraint=$4 expected=$5 pinned=$6
  local cfg="$scratch/$name.cfg" log="$scratch/$name.out"
  {
    echo "CONSTANTS"
    echo "  Standbys = $standbys"
    echo "  Launches = $launches"
    echo "  NoId = NoId"
    echo "  Mutant = \"$mutant\""
    echo "SPECIFICATION Spec"
    echo "INVARIANT TypeOK"
    for inv in $invariants; do echo "INVARIANT $inv"; done
    [[ -n "$constraint" ]] && echo "ACTION_CONSTRAINT $constraint"
    echo "SYMMETRY Symmetry"
    echo "CHECK_DEADLOCK FALSE"
  } >"$cfg"
  # A row expected to fail runs on one worker, so the breadth-first search stops at the same
  # shortest trace and the same count every time; a row expected to hold uses every core.
  local workers=auto
  [[ "$expected" == holds ]] || workers=1
  local started=$SECONDS
  (cd "$here" && "${checker[@]}" -workers "$workers" -config "$cfg" \
    -metadir "$scratch/meta-$name" MCStandbyDiscard.tla) 2>&1 \
    | grep -v '^Picked up JAVA_TOOL_OPTIONS' >"$log" || true
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

echo "$header · Standbys = $standbys · Launches = $launches · $(git -C "$root" rev-parse --short HEAD)"
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
