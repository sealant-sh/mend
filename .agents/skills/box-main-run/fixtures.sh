#!/usr/bin/env bash
# Make every fixture the box run's flows need (flows.md, Fixtures), or check that it is there. Safe
# to run again: each step looks first and changes nothing that is already right. With an empty
# database it rebuilds them all, except the steps that cannot be scripted within the rules: those it
# names, and it exits 3.
#
#   MEND_VERIFY_BOX_SSH="$(cat ~/.local/state/mend-main-run/lanes/<lane>/ssh)" LANE=<lane> \
#     .agents/skills/box-main-run/fixtures.sh <hold tag>
#
# The box is the lane's check VM copy (SKILL.md, Lanes). Run it from the worktree's root, while this
# check holds that copy as <hold tag> (`pnpm verify box prepare --tag <hold tag> --yes`): it refuses
# otherwise. MEND_CLI defaults to the mend names.sh installed (SKILL.md, step 4), and the address
# names.sh read for the lane. It never signs the first account's
# CLI in or out, and reads no token: the second account is signed in with its own config and
# password file, and only when its saved login is missing.
#
# One line per fixture: `fixture <name> · present`, `· made`, or `· manual: <the step>`.
# Exit 0: every fixture is there. 1: a step failed (its line says how). 3: a manual step remains.
set -uo pipefail

tag=${1:?usage: fixtures.sh <hold tag>}
: "${MEND_VERIFY_BOX_SSH:?set MEND_VERIFY_BOX_SSH}"
MEND_CLI=${MEND_CLI:-$HOME/.local/state/mend-main-run/cli/node_modules/.bin/mend}
read -r -a box_ssh <<<"$MEND_VERIFY_BOX_SSH"

# The copy's address, as names.sh read it for the lane (SKILL.md, step 4).
: "${LANE:?set LANE to the lane (a, b or c)}"
WEB=$(cat "$HOME/.local/state/mend-main-run/lanes/$LANE/web" 2>/dev/null)
[[ $WEB =~ ^https?:// ]] || { echo "fixtures.sh: no address in ~/.local/state/mend-main-run/lanes/$LANE/web; run names.sh first" >&2; exit 2; }
KIT=$HOME/.local/share/mend-boat-check
KIT2=$HOME/.local/share/mend-boat-check-2
EMAIL2=main-run-second@example.test
NAME2="Main Run Second"
REPOS=(land second)

box() { ssh -o BatchMode=yes -o ConnectTimeout=10 "${box_ssh[@]}" "bash -s" <<<"{
$1
}"; }
M() { XDG_CONFIG_HOME=$KIT/cli MEND_URL=$WEB "$MEND_CLI" "$@"; }
M2() { XDG_CONFIG_HOME=$KIT2/cli MEND_URL=$WEB "$MEND_CLI" "$@"; }
say() { printf 'fixture %s · %s\n' "$1" "$2"; }
manual=0
failed=0

# This check holds the box.
held=$(box "cat /var/lib/mend-box-check/hold.json 2>/dev/null" | jq -r '.tag // empty' 2>/dev/null)
if [[ $held != "$tag" ]]; then
  echo "fixtures.sh: the box is not held as $tag (held: ${held:-nobody}); take the hold first" >&2
  exit 2
fi
[[ $(M doctor 2>&1) == *"$WEB"* ]] || { echo "fixtures.sh: the first account's CLI does not name $WEB" >&2; exit 2; }

# 1. The git service: git daemon on the Mend containers' bridge gateway, serving /srv/mend-git with
# pushes allowed. The server reaches it (adoption, references, landings). A Boat workspace does not,
# and cannot on any address of the box: a Boat VM sits on its own network and reaches the box only
# through Tailscale Funnel's public HTTPS ports (checked 18 Nov, SLNT-1102). So the flows that clone
# inside a Boat workspace use GitHub-hosted projects instead.
gw=$(box "docker inspect --format '{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}' mend-mend-1" | awk '{print $1}')
if [[ ! $gw =~ ^[0-9.]+$ ]]; then
  say git-service "failed: no bridge gateway read from mend-mend-1"
  exit 1
fi
GIT=git://$gw:9418
unit="[Unit]
Description=Git service for the box run's fixtures (SLNT-1050)
After=docker.service
[Service]
ExecStart=/usr/bin/git daemon --reuseaddr --base-path=/srv/mend-git --export-all --enable=receive-pack --listen=$gw --port=9418 /srv/mend-git
Restart=always
[Install]
WantedBy=multi-user.target"
state=$(box "set -u
mkdir -p /srv/mend-git
f=/etc/systemd/system/mend-box-git.service
want=\$(cat <<'UNIT'
$unit
UNIT
)
if [ \"\$(cat \$f 2>/dev/null)\" = \"\$want\" ] && systemctl is-active --quiet mend-box-git; then echo present; exit 0; fi
printf '%s\n' \"\$want\" > \$f && systemctl daemon-reload && systemctl enable --now mend-box-git >/dev/null 2>&1 && systemctl restart mend-box-git
sleep 1
ss -ltn | grep -q '$gw:9418' && echo made || echo failed")
say git-service "${state:-failed} ($GIT)"
[[ $state == failed || -z $state ]] && exit 1

# 2. Its bare repositories, each with one commit on main.
for r in "${REPOS[@]}"; do
  state=$(box "set -u
d=/srv/mend-git/$r.git
if git -C \$d rev-parse --verify -q refs/heads/main >/dev/null 2>&1; then echo present; exit 0; fi
git init -q --bare -b main \$d
t=\$(mktemp -d) && git -C \$t init -q -b main && printf 'The box run fixture $r (SLNT-1050).\n' > \$t/README.md
git -C \$t -c user.name='Mend box run' -c user.email=main-run@example.test add README.md
git -C \$t -c user.name='Mend box run' -c user.email=main-run@example.test commit -q -m 'Seed $r'
git -C \$t push -q \$d main && echo made || echo failed
rm -rf \$t")
  say "repository $r" "${state:-failed} ($GIT/$r.git)"
  [[ $state == failed || -z $state ]] && failed=1
done

# 3. The projects adopted from them. A project adopted from another origin is removed, purged and
# adopted again from $GIT: a project's origin is fixed at adoption, and its worktrees go with it.
projects=$(M projects --json 2>/dev/null)
for r in "${REPOS[@]}"; do
  name=main-run-$r
  origin=$(jq -r --arg n "$name" '[.. | objects | select(.name? == $n) | .originUrl // empty][0] // empty' <<<"$projects")
  id=$(jq -r --arg n "$name" '[.. | objects | select(.name? == $n) | .id // empty][0] // empty' <<<"$projects")
  if [[ -n $id && $origin == "$GIT/$r.git" ]]; then
    say "project $name" present
    continue
  fi
  if [[ -n $id ]]; then
    # A worktree whose change never landed holds the project, and mend refuses to remove it: remove
    # those worktrees first, one plain command each, as the refusal says to.
    for wt in $(M worktrees --project "$name" --json 2>/dev/null | jq -r '.worktrees[]?.name // empty'); do
      M worktrees rm "$wt" --force --project "$name" >/dev/null 2>&1
    done
    if ! M projects rm "$id" >/dev/null 2>&1 || ! M projects purge "$id" --confirm "$name" >/dev/null 2>&1; then
      say "project $name" "failed: could not remove the project adopted from $origin"
      failed=1
      continue
    fi
  fi
  if M adopt "$GIT/$r.git" --name "$name" --json >/dev/null 2>&1; then
    say "project $name" "made${origin:+ (was $origin)}"
  else
    say "project $name" "failed: mend adopt $GIT/$r.git --name $name refused"
    failed=1
  fi
done

# 4. The GitHub-hosted projects boat-check-ubuntu and boat-check-arch, and boat-check-ubuntu's
# Docker worktree, made by hand once (flows.md, Fixtures).
if jq -e '.. | objects | select(.name? == "boat-check-ubuntu")' <<<"$projects" >/dev/null 2>&1; then
  say "project boat-check-ubuntu" present
else
  say "project boat-check-ubuntu" "manual: M adopt https://github.com/octocat/Hello-World.git --name boat-check-ubuntu"
  manual=1
fi
if jq -e '.. | objects | select(.name? == "boat-check-arch")' <<<"$projects" >/dev/null 2>&1; then
  say "project boat-check-arch" present
else
  say "project boat-check-arch" "manual: M adopt https://github.com/octocat/Spoon-Knife.git --name boat-check-arch"
  manual=1
fi
if M worktrees --project boat-check-ubuntu 2>/dev/null | grep -q 'main-run-docker'; then
  say "worktree main-run-docker" present
else
  say "worktree main-run-docker" "manual: as flows.md's Fixtures says (the organization's runtime is switched on the web)"
  manual=1
fi

# 5. The second account: a member of Default, with its own CLI config and password file.
mkdir -p "$KIT2/cli/mend" && chmod 700 "$KIT2" "$KIT2/cli"
if [[ ! -s $KIT2/password ]]; then
  (umask 077 && openssl rand -base64 24 | tr -d '\n' > "$KIT2/password")
fi
if [[ -s $KIT2/cli/mend/cli.json ]] && M2 doctor 2>&1 | grep -q "$WEB"; then
  say "second account" present
else
  P2=$(mktemp -d) && chmod 700 "$P2"
  out=$(mktemp -d)
  jq -n --arg e "$EMAIL2" --rawfile p "$KIT2/password" '{email:$e,password:$p}' > "$P2/account.json"
  export MEND_VERIFY_OUTER_URL=$WEB MEND_VERIFY_PRIVATE=$P2
  drive() { node .agents/skills/verify/scripts/drive-web.mjs --web "$WEB" --private "$P2" --state "$P2/browser.json" "$@" >/dev/null 2>&1; }
  ok=1
  if ! M members 2>/dev/null | grep -q "$EMAIL2"; then
    link=$(M invite --email "$EMAIL2" --role member --days 1 2>/dev/null | head -1)
    joined=0
    if [[ $link == "$WEB/join#"* ]]; then
      export MAIN_RUN_JOIN_URL=$link MAIN_RUN_JOIN_NAME=$NAME2 MAIN_RUN_JOIN_EMAIL=$EMAIL2
      export MAIN_RUN_JOIN_PASSWORD_FILE=$KIT2/password
      drive --out "$out/join" --recipe .agents/skills/box-main-run/recipes/fixture-join.mjs && joined=1
    fi
    if ((!joined)); then
      say "second account" "failed: the invitation or the join, evidence in $out/join"
      ok=0
    fi
  fi
  if ((ok)); then
    M2 login --url "$WEB" --no-open > "$P2/login.out" 2>&1 &
    login=$!
    url=
    for _ in $(seq 60); do
      url=$(grep -o "$WEB/authorize?code=[A-Z0-9-]*" "$P2/login.out" | head -1)
      [[ -n $url ]] && break
      sleep 1
    done
    signed=0
    if [[ -n $url ]]; then
      export MAIN_RUN_AUTHORIZE_URL=$url
      if drive --account "$P2/account.json" --out "$out/authorize" \
        --recipe .agents/skills/box-main-run/recipes/fixture-authorize.mjs; then
        wait "$login" && grep -q "signed in as $EMAIL2" "$P2/login.out" && signed=1
      fi
    fi
    if ((signed)); then
      say "second account" made
    else
      kill "$login" 2>/dev/null
      say "second account" "failed: its CLI sign-in, evidence in $out/authorize"
      ok=0
    fi
  fi
  rm -rf "$P2"
  ((ok)) && rm -rf "$out" || failed=1
fi

((failed)) && exit 1
((manual)) && exit 3
exit 0
