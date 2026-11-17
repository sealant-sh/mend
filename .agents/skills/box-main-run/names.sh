#!/usr/bin/env bash
# Set up the names a run's commands use, at fixed paths, so that every command, a removal included,
# is one plain command a harness can read (SKILL.md, step 4). A shell function or variable does not
# outlive one tool call, and a removal hidden in `bash -c '…'` or a sourced file is refused by
# Claude Code's removal check, so nothing here relies on either.
#
#   .agents/skills/box-main-run/names.sh <the CLI tarball verify box cli packed>
#
# Run it from the worktree's root. It writes, under ~/.local/state/mend-main-run:
#   cli/           this commit's mend, installed from the tarball
#   private/       mode 700: account.json and account2.json (the two accounts' sign-in for the
#                  web driver), browser.json and browser2.json once the driver saves them. Only
#                  credentials live here: the evidence scan reads every value in it as a secret.
#   bin/M          mend as the checker account          bin/M2   mend as the second account
#   bin/box        a command on the box over ssh: box '<command>'
#   bin/web        the verify skill's web driver against the box, as the checker account
#                  (web2: as the second account): web <out dir> <recipe> [driver flags…]
# The wrappers hold paths only, never a password or a token.
set -euo pipefail

tarball=${1:?usage: names.sh <cli tarball>}
STATE=$HOME/.local/state/mend-main-run
KIT=$HOME/.local/share/mend-boat-check
KIT2=$HOME/.local/share/mend-boat-check-2
WEB=https://yiannis-k8s-arc.tailc79e49.ts.net
BOX='-J mendbox root@10.0.0.41'
root=$(pwd)
[[ -f $root/.agents/skills/verify/scripts/drive-web.mjs ]] || { echo "names.sh: run it from the worktree's root" >&2; exit 2; }

mkdir -p "$STATE/bin" "$STATE/cli" "$STATE/private"
chmod 700 "$STATE/private"
npm install --silent --no-audit --no-fund --prefix "$STATE/cli" "$tarball" >/dev/null

(
  umask 077
  jq -n --rawfile p "$KIT/password" '{email:"boat-check@example.test",password:($p|rtrimstr("\n"))}' \
    >"$STATE/private/account.json"
  if [[ -s $KIT2/password ]]; then
    jq -n --rawfile p "$KIT2/password" '{email:"main-run-second@example.test",password:($p|rtrimstr("\n"))}' \
      >"$STATE/private/account2.json"
  fi
)

write() { printf '%s\n' "#!/usr/bin/env bash" "$2" >"$STATE/bin/$1" && chmod 755 "$STATE/bin/$1"; }
write M "exec env XDG_CONFIG_HOME=$KIT/cli $STATE/cli/node_modules/.bin/mend \"\$@\""
write M2 "exec env XDG_CONFIG_HOME=$KIT2/cli $STATE/cli/node_modules/.bin/mend \"\$@\""
write box "exec ssh -o BatchMode=yes -o ConnectTimeout=10 $BOX \"\$@\""
driver() {
  printf '%s\n' "cd $root" "out=\${1:?usage: $1 <out dir> <recipe> [driver flags]}; recipe=\${2:?usage: $1 <out dir> <recipe>}; shift 2" \
    "exec env MEND_VERIFY_OUTER_URL=$WEB MEND_VERIFY_PRIVATE=$STATE/private node .agents/skills/verify/scripts/drive-web.mjs --web $WEB --out \"\$out\" --private $STATE/private --account $STATE/private/$2.json --state $STATE/private/$3.json --recipe \"\$recipe\" \"\$@\""
}
write web "$(driver web account browser)"
write web2 "$(driver web2 account2 browser2)"

"$STATE/bin/M" doctor 2>&1 | grep -q "$WEB" || { echo "names.sh: bin/M does not name $WEB" >&2; exit 1; }
echo "names · $STATE/bin/{M,M2,box,web,web2} · cli $("$STATE/bin/M" --version 2>/dev/null | head -1)"
