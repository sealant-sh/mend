#!/usr/bin/env bash
# Set up the names one lane's commands use, at fixed paths, so that every command, a removal
# included, is one plain command a harness can read (SKILL.md, step 4). A shell function or variable
# does not outlive one tool call, and a removal hidden in `bash -c '…'` or a sourced file is refused
# by Claude Code's removal check, so nothing here relies on either.
#
#   MEND_VERIFY_BOX_SSH='<the copy>' .agents/skills/box-main-run/names.sh <lane> <the CLI tarball>
#
# <lane> is a, b or c: one check VM copy each (SKILL.md, Lanes). MEND_VERIFY_BOX_SSH is what
# `pnpm verify vm up` printed for that lane's copy. Run it from the worktree's root, once the copy
# is held and before the deploy, one lane after another. It writes, under
# ~/.local/state/mend-main-run:
#   cli/                 this commit's mend, installed from the tarball (shared by the lanes)
#   private/             mode 700: account.json and account2.json (the two accounts' sign-in for
#                        the web driver), and browser-<lane>.json and browser2-<lane>.json once the
#                        driver saves them. Only credentials live here: the evidence scan reads
#                        every value in it as a secret.
#   lanes/<lane>/web     the copy's address: APP_URL of its active generation, read over ssh
#   lanes/<lane>/ssh     the copy's ssh arguments
#   lanes/<lane>/bin/M   mend as the checker account      lanes/<lane>/bin/M2   as the second account
#                        (each with MEND_URL set to the lane's web: the accounts' saved logins work
#                        at any address of the run's data; nothing signs in and no token is read)
#   lanes/<lane>/bin/box a command on the copy over ssh: box '<command>'
#   lanes/<lane>/bin/web the verify skill's web driver against the copy, as the checker account
#                        (web2: as the second account): web <out dir> <recipe> [driver flags…]
# The wrappers hold paths only, never a password or a token.
set -euo pipefail

lane=${1:?usage: names.sh <a|b|c> <cli tarball>}
tarball=${2:?usage: names.sh <a|b|c> <cli tarball>}
[[ $lane =~ ^[abc]$ ]] || { echo "names.sh: the lane is a, b or c" >&2; exit 2; }
: "${MEND_VERIFY_BOX_SSH:?set MEND_VERIFY_BOX_SSH to the copy of the lane, as pnpm verify vm up printed it}"
STATE=$HOME/.local/state/mend-main-run
L=$STATE/lanes/$lane
KIT=$HOME/.local/share/mend-boat-check
KIT2=$HOME/.local/share/mend-boat-check-2
root=$(pwd)
[[ -f $root/.agents/skills/verify/scripts/drive-web.mjs ]] || { echo "names.sh: run it from the worktree's root" >&2; exit 2; }
read -r -a box_ssh <<<"$MEND_VERIFY_BOX_SSH"

mkdir -p "$L/bin" "$STATE/cli" "$STATE/private"
WEB=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "${box_ssh[@]}" "sed -n 's/^APP_URL=//p' /root/.config/mend/active/server.env" | tr -d '\r')
[[ $WEB =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || { echo "names.sh: the copy's APP_URL could not be read (got '$WEB')" >&2; exit 1; }
printf '%s\n' "$WEB" >"$L/web"
printf '%s\n' "$MEND_VERIFY_BOX_SSH" >"$L/ssh"
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

write() { printf '%s\n' "#!/usr/bin/env bash" "$2" >"$L/bin/$1" && chmod 755 "$L/bin/$1"; }
write M "exec env XDG_CONFIG_HOME=$KIT/cli MEND_URL=$WEB $STATE/cli/node_modules/.bin/mend \"\$@\""
write M2 "exec env XDG_CONFIG_HOME=$KIT2/cli MEND_URL=$WEB $STATE/cli/node_modules/.bin/mend \"\$@\""
write box "exec ssh -o BatchMode=yes -o ConnectTimeout=10 $MEND_VERIFY_BOX_SSH \"\$@\""
driver() {
  printf '%s\n' "cd $root" "out=\${1:?usage: $1 <out dir> <recipe> [driver flags]}; recipe=\${2:?usage: $1 <out dir> <recipe>}; shift 2" \
    "exec env MEND_VERIFY_OUTER_URL=$WEB MEND_VERIFY_PRIVATE=$STATE/private node .agents/skills/verify/scripts/drive-web.mjs --web $WEB --out \"\$out\" --private $STATE/private --account $STATE/private/$2.json --state $STATE/private/$3-$lane.json --recipe \"\$recipe\" \"\$@\""
}
write web "$(driver web account browser)"
write web2 "$(driver web2 account2 browser2)"

echo "names · lane $lane · $L/bin/{M,M2,box,web,web2} · web $WEB · cli $("$L/bin/M" --version 2>/dev/null | head -1)"
