#!/usr/bin/env bash
# Model-checks StandbyDiscard.tla with TLC (README.md beside this file says what it checks).
#
#   check.sh           every row of ROWS at the full bounds; exits 0 only when each row ends as
#                      ROWS expects
#   check.sh --quick   the same with one launch instead of two: seconds, for iterating on a change
#   check.sh <row>     one row at the full bounds, printing TLC's whole output and its trace
#
# TLC is tla2tools 1.7.4 (TLC 2.19), checked against its sha256 before it runs. It comes from the
# repository's pinned nixpkgs when Nix is installed, else from the GitHub release (needs java and
# curl), or from TLA2TOOLS_JAR when that is set.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel)

TLA2TOOLS_VERSION=1.7.4
TLA2TOOLS_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88

# row | base | mutant | invariants | action constraint | expected outcome
#
# The first row is the finding: the code as it is breaks the promise. It stays "violated" until the
# code is fixed; then model the fix as the code and expect "holds" (README.md, "When the code
# changes"). The mutants run on a base that passes everything, so each one fails only because of
# its own break.
ROWS=(
  "code-promise|code|none|NoDiscardOfSessionWork||violated NoDiscardOfSessionWork"
  "code-promise-atomic-retire|code|none|NoDiscardOfSessionWork|RetireIsAtomic|violated NoDiscardOfSessionWork"
  "code-promise-no-sweep|code|none|NoDiscardOfSessionWork|NoSweep|holds"
  "code-claimable|code|none|NoClaimableRowWithSession||holds"
  "fix-reread-session|fix-reread-session|none|NoDiscardOfSessionWork NoClaimableRowWithSession||holds"
  "fix-setfailed-unless-claimed|fix-setfailed-unless-claimed|none|NoDiscardOfSessionWork NoClaimableRowWithSession||holds"
  "mutant-retire-ignores-status|fix-setfailed-unless-claimed|retire-ignores-status|NoDiscardOfSessionWork||violated NoDiscardOfSessionWork"
  "mutant-discard-before-retire|fix-setfailed-unless-claimed|discard-before-retire|NoDiscardOfSessionWork||violated NoDiscardOfSessionWork"
  "mutant-claim-leaves-ready|fix-setfailed-unless-claimed|claim-leaves-ready|NoClaimableRowWithSession||violated NoClaimableRowWithSession"
  "mutant-reused-id|fix-setfailed-unless-claimed|reused-id|NoClaimableRowWithSession||violated NoClaimableRowWithSession"
)

standbys="{s1, s2}"
launches="{l1, l2}"
only=""
case "${1:-}" in
  "") ;;
  --quick) launches="{l1}" ;;
  -h | --help)
    sed -n '2,10p' "$0"
    exit 0
    ;;
  *) only=$1 ;;
esac

scratch=$(mktemp -d -t standby-discard.XXXXXX)
trap 'rm -rf -- "$scratch"' EXIT

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

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

run_row() {
  local name=$1 base=$2 mutant=$3 invariants=$4 constraint=$5 expected=$6
  local cfg="$scratch/$name.cfg" log="$scratch/$name.out"
  {
    echo "CONSTANTS"
    echo "  Standbys = $standbys"
    echo "  Launches = $launches"
    echo "  NoId = NoId"
    echo "  Base = \"$base\""
    echo "  Mutant = \"$mutant\""
    echo "SPECIFICATION Spec"
    echo "INVARIANT TypeOK"
    for inv in $invariants; do echo "INVARIANT $inv"; done
    [[ -n "$constraint" ]] && echo "ACTION_CONSTRAINT $constraint"
    echo "SYMMETRY Symmetry"
    echo "CHECK_DEADLOCK FALSE"
  } >"$cfg"
  # A row expected to fail runs on one worker, so TLC's breadth-first search prints the same
  # shortest trace every time; a row expected to hold uses every core.
  local workers=auto
  [[ "$expected" == holds ]] || workers=1
  local started=$SECONDS
  (cd "$here" && "${tlc[@]}" -workers "$workers" -difftrace -config "$cfg" \
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
  states=$(grep -o '[0-9,]* distinct states found' "$log" | tail -1 | cut -d' ' -f1)
  local verdict="as expected"
  [[ "$observed" == "$expected" ]] || verdict="NOT AS EXPECTED"
  printf '%-30s %-38s %-38s %12s %5ss  %s\n' "$name" "expected: $expected" "observed: $observed" \
    "${states:-?}" "$seconds" "$verdict"
  if [[ -n "$only" || "$verdict" != "as expected" ]]; then
    echo "----- TLC output for $name -----"
    cat "$log"
    echo "----- end of $name -----"
  fi
  [[ "$verdict" == "as expected" ]]
}

echo "tla2tools $TLA2TOOLS_VERSION · Standbys = $standbys · Launches = $launches · $(git -C "$root" rev-parse --short HEAD)"
failed=0
matched=0
for row in "${ROWS[@]}"; do
  IFS='|' read -r name base mutant invariants constraint expected <<<"$row"
  [[ -n "$only" && "$name" != "$only" ]] && continue
  matched=1
  run_row "$name" "$base" "$mutant" "$invariants" "$constraint" "$expected" || failed=1
done
if [[ $matched -eq 0 ]]; then
  echo "check.sh: no row named $only; rows are:" >&2
  for row in "${ROWS[@]}"; do echo "  ${row%%|*}" >&2; done
  exit 2
fi
exit $failed
