#!/usr/bin/env bash
# Runs INSIDE the master VM, as root, once, from `pnpm verify vm build` (vm.mjs): it makes a stock
# Ubuntu cloud image into a box like VM 131 (docs/operations/preview-builds.md, "The box"), the way
# an operator installs Mend. Each phase is idempotent, so a build that stopped part way runs again.
#
#   vm-provision.sh system <node version>           Docker, git, jq, Node, the git service unit
#   vm-provision.sh cli <mend cli version>          the global mend CLI, as the box has it
#   vm-provision.sh server <version> <sha> <url>    preview-deploy.sh: mend server setup, Docker only
#   vm-provision.sh web [<address>]                 the forward of Mend's loopback port to QEMU's
#   vm-provision.sh git                             the box run's git service on mend_default's gateway
#   vm-provision.sh seal                            stop Mend, turn cloud-init off, trim the disk
#
# identity.env (the box's install secrets) and the run's data are copied in by vm.mjs over ssh
# before `server`; nothing here prints a secret.
set -euo pipefail

say() { printf 'vm-provision: %s\n' "$*"; }
phase=${1:?usage: vm-provision.sh <phase> [args]}
shift

case $phase in
system)
  node_version=${1:?node version}
  cloud-init status --wait >/dev/null 2>&1 || true
  export DEBIAN_FRONTEND=noninteractive
  if ! command -v jq >/dev/null 2>&1 || [[ ! -e /usr/lib/x86_64-linux-gnu/libatomic.so.1 ]]; then
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl git jq libatomic1 >/dev/null
  fi
  if ! command -v docker >/dev/null 2>&1; then
    say "installing Docker from get.docker.com"
    curl -fsSL https://get.docker.com | sh >/dev/null
  fi
  mkdir -p /etc/docker
  printf '%s\n' '{"log-driver": "local"}' >/etc/docker/daemon.json
  systemctl restart docker
  if [[ $(node --version 2>/dev/null) != "v$node_version" ]]; then
    say "installing Node $node_version"
    dir=/opt/node-v$node_version-linux-x64
    curl -fsSL "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-x64.tar.xz" | tar -xJ -C /opt
    for tool in node npm npx; do ln -sf "$dir/bin/$tool" "/usr/local/bin/$tool"; done
  fi
  node --version >/dev/null
  say "docker $(docker version --format '{{.Server.Version}}'), node $(node --version)"
  ;;
cli)
  cli_version=${1:?mend cli version}
  if [[ $(mend --version 2>/dev/null | head -1) != "mend $cli_version" ]]; then
    npm install --global --silent --no-audit --no-fund "@sealant/mend@$cli_version" >/dev/null
    ln -sf "$(npm prefix --global)/bin/mend" /usr/local/bin/mend
  fi
  say "$(mend --version | head -1)"
  ;;
server)
  version=${1:?version}
  sha=${2:?sha}
  url=${3:?url}
  [[ -s /root/.config/mend/identity.env ]] || { say "no identity.env: vm.mjs copies it first" >&2; exit 1; }
  if docker inspect mend-mend-1 >/dev/null 2>&1; then
    say "Mend is installed already: $(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' mend-mend-1)"
    exit 0
  fi
  curl -fsSL --retry 3 -o /root/preview-deploy.sh \
    "https://raw.githubusercontent.com/sealant-sh/mend/$sha/scripts/preview-deploy.sh"
  # Sessions run in Docker inside the VM: no Boat key or deployment id is copied (SLNT-1215 adds it).
  # Mend binds loopback, as setup requires of a loopback --url; `web` carries QEMU's forward to it.
  bash /root/preview-deploy.sh "$version" "$sha" --yes --url "$url" \
    --session-runtime docker --session-runtimes docker --allow-userns
  ;;
web)
  # QEMU's user-mode network forwards the host's <copy address>:3105 to this VM's 13105, and setup
  # publishes Mend on 127.0.0.1:3105 only (a loopback --url takes a loopback bind). A systemd socket
  # proxy joins the two, and with <address> also answers on the copy's own address here, so its
  # APP_URL resolves inside the VM as it does on the host. Two more carry the Boat endpoints setup
  # publishes on loopback with Boat on (session channel 13106, bucket 13900) to 23106 and 23900,
  # which QEMU forwards from the host for the Funnel (SLNT-1215).
  proxy() { # <unit> <description> <target> <listen…>
    local unit=$1 description=$2 target=$3
    shift 3
    { printf '%s\n' "[Unit]" "Description=$description" "[Socket]"
      printf 'ListenStream=%s\n' "$@"
      printf '%s\n' "[Install]" "WantedBy=sockets.target"; } >"/etc/systemd/system/$unit.socket"
    printf '%s\n' "[Unit]" "Requires=$unit.socket" "After=$unit.socket" \
      "[Service]" "ExecStart=/usr/lib/systemd/systemd-socket-proxyd $target" >"/etc/systemd/system/$unit.service"
  }
  proxy mend-web-proxy "Mend's web port for the check VM's forward (SLNT-1214)" 127.0.0.1:3105 \
    13105 ${1:+"$1:3105"}
  proxy mend-session-proxy "Mend's session endpoint for the Funnel (SLNT-1215)" 127.0.0.1:13106 23106
  proxy mend-blob-proxy "Mend's bucket for the Funnel (SLNT-1215)" 127.0.0.1:13900 23900
  rm -rf /etc/systemd/system/mend-web-proxy.socket.d
  systemctl daemon-reload
  for unit in mend-web-proxy mend-session-proxy mend-blob-proxy; do
    systemctl enable "$unit.socket" >/dev/null 2>&1
    systemctl stop "$unit.service" >/dev/null 2>&1 || true
    systemctl restart "$unit.socket"
  done
  say "web forward on 13105${1:+ and $1:3105}; Boat endpoints on 23106 and 23900"
  ;;
git)
  # The box run's git service (.agents/skills/box-main-run/fixtures.sh, step 1), on the same bridge
  # gateway as on the box, so the loaded projects' origins answer unchanged.
  gw=$(docker network inspect --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}' mend_default | awk '{print $1}')
  [[ $gw =~ ^[0-9.]+$ ]] || { say "no gateway on mend_default" >&2; exit 1; }
  printf '%s\n' "[Unit]" "Description=Git service for the box run's fixtures (SLNT-1050)" "After=docker.service" \
    "[Service]" \
    "ExecStart=/usr/bin/git daemon --reuseaddr --base-path=/srv/mend-git --export-all --enable=receive-pack --listen=$gw --port=9418 /srv/mend-git" \
    "Restart=always" "RestartSec=1" "[Install]" "WantedBy=multi-user.target" >/etc/systemd/system/mend-box-git.service
  systemctl daemon-reload
  systemctl enable --now mend-box-git >/dev/null 2>&1
  systemctl restart mend-box-git
  say "git service on git://$gw:9418"
  ;;
seal)
  mend server stop >/dev/null 2>&1 || docker stop mend-mend-1 >/dev/null 2>&1 || true
  touch /etc/cloud/cloud-init.disabled
  apt-get clean
  rm -f /root/preview-deploy.sh
  fstrim -a >/dev/null 2>&1 || true
  sync
  say "sealed"
  ;;
*)
  say "unknown phase $phase" >&2
  exit 2
  ;;
esac
