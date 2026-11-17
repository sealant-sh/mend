#!/usr/bin/env bash
# The scripted CLI flows of the box run (flows.md, `Mode: scripted (recipes/cli-reads.sh <id>)`):
# each only reads, runs its commands as the checker account, and checks every part of the flow's
# See line. A flow this marks `failed` goes to an agent, who sees it again before it is reported
# (SKILL.md, step 5).
#
#   MEND_CLI=$C/node_modules/.bin/mend KIT=$KIT WEB=$WEB E=$E SHA8=<sha8> \
#     .agents/skills/box-main-run/recipes/cli-reads.sh <flow id>
#
# Writes <E>/<flow id>/cli.log (each command, its stdout and stderr, and its exit) and
# <E>/<flow id>/result.txt (`seen` or `failed`, then one line per part of the See line). Exit 0 when
# seen, 1 when not, 2 on a usage error.
set -uo pipefail

flow=${1:-}
: "${MEND_CLI:?set MEND_CLI}" "${KIT:?set KIT}" "${WEB:?set WEB}" "${E:?set E}"
P=${P:-boat-check-ubuntu}
dir=$E/$flow
log=$dir/cli.log
parts=()
ok=1

M() { XDG_CONFIG_HOME=$KIT/cli "$MEND_CLI" "$@"; }

# run <name> <command...>: runs it, logs it, and keeps its stdout in $out and exit in $code.
run() {
  local err
  err=$(mktemp)
  out=$("${@:2}" 2>"$err")
  code=$?
  { printf '$ %s\n' "${*:2}"; printf '%s\n' "$out"; sed 's/^/stderr: /' "$err"; printf 'exit %s\n\n' "$code"; } >>"$log"
  rm -f "$err"
}

# part <description> <test...>: one part of the See line, seen or not.
part() {
  if "${@:2}"; then parts+=("seen · $1"); else parts+=("not seen · $1"); ok=0; fi
}
has() { grep -Eq -- "$1" <<<"$out"; }
lacks() { ! grep -Eq -- "$1" <<<"$out"; }
exits() { [[ $code == "$1" ]]; }

case $flow in
  doctor.checklist)
    mkdir -p "$dir" && : >"$log"
    run doctor M doctor
    part "exit 0" exits 0
    part "✓ server naming $WEB · mend <version>" has "^✓ server +${WEB//./\\.} · mend [0-9]"
    part "✓ signed in · token accepted" has '^✓ signed in +token accepted'
    part "✓ sealant · connected" has '^✓ sealant +connected'
    part "✓ codex · connected" has '^✓ codex +connected'
    part "no line marked ✗" lacks '^✗'
    parts+=("recorded · $(grep -E '^. (claude|github) ' <<<"$out" | tr -s ' ' | paste -sd ';' -)")
    ;;
  cli.version)
    mkdir -p "$dir" && : >"$log"
    run version M version
    part "exit 0" exits 0
    part "mend <version>" has '^mend [0-9]'
    part "server <version> · $WEB" has "^server [0-9][^ ]* · ${WEB//./\\.}\$"
    parts+=("recorded · $(grep -c 'versions differ' <<<"$out") versions-differ line (a CLI packed from source carries the package's version)")
    ;;
  now-and-sessions.cli-lists)
    : "${SHA8:?set SHA8}"
    mkdir -p "$dir" && : >"$log"
    run projects M projects
    part "M projects exits 0 and lists $P" bash -c "[[ $code == 0 ]] && grep -Eq '^ *$P ' <<<\"\$0\"" "$out"
    run sessions M sessions --all --project "$P"
    part "M sessions --all lists main-run-$SHA8" bash -c "[[ $code == 0 ]] && grep -q 'main-run-$SHA8' <<<\"\$0\"" "$out"
    run worktrees M worktrees --project "$P"
    for wt in "main-run-$SHA8" "main-run-run-$SHA8" main-run-docker; do
      part "M worktrees lists $wt" bash -c "[[ $code == 0 ]] && grep -q '$wt' <<<\"\$0\"" "$out"
    done
    ;;
  *)
    echo "usage: cli-reads.sh doctor.checklist|cli.version|now-and-sessions.cli-lists" >&2
    exit 2
    ;;
esac

{ ((ok)) && echo seen || echo failed; printf '%s\n' "${parts[@]}"; echo "evidence · $log"; } >"$dir/result.txt"
cat "$dir/result.txt"
((ok))
