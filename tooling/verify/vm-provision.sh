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
#   vm-provision.sh tailnet <hostname>              a Boat slot's Tailscale, from its disk (vm-boat.mjs)
#   vm-provision.sh tailnet-funnel                  the copy's own Funnel: 8443 and 10000 to Mend
#   vm-provision.sh tailnet-cert <dns name>         the slot's HTTPS certificate, kept in its state
#   vm-provision.sh tailnet-wait <dns name>         until the copy's own Funnel answers
#   vm-provision.sh tailnet-down                    flush and unmount the slot before the VM stops
#   vm-provision.sh tailnet-logout                  the slot's node leaves the tailnet
#   vm-provision.sh boat-journals                   the saved Boat build journals into Boat's volume
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
  # APP_URL resolves inside the VM as it does on the host.
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
  rm -rf /etc/systemd/system/mend-web-proxy.socket.d
  systemctl daemon-reload
  for unit in mend-web-proxy; do
    systemctl enable "$unit.socket" >/dev/null 2>&1
    systemctl stop "$unit.service" >/dev/null 2>&1 || true
    systemctl restart "$unit.socket"
  done
  say "web forward on 13105${1:+ and $1:3105}"
  ;;
tailnet)
  # A Boat slot's tailnet identity lives on its own disk (serial mendtailnet), outside the copy's
  # throwaway overlay: tailscaled's state directory, with its node key and certificates. tailscaled
  # runs in userspace networking, so the VM's routes, DNS and Docker stay as they are; Funnel needs no
  # tun. With /run/mend-tailnet-authkey present (a new slot) it logs in with that key, read from the
  # file, never a command line, and removes the file at once.
  host=${1:?hostname}
  dev=/dev/disk/by-id/virtio-mendtailnet
  [[ -b $dev ]] || { say "no slot disk at $dev" >&2; exit 1; }
  blkid "$dev" >/dev/null 2>&1 || mkfs.ext4 -q -L mend-tailnet "$dev"
  mkdir -p /var/lib/tailscale
  mountpoint -q /var/lib/tailscale || mount "$dev" /var/lib/tailscale
  chmod 700 /var/lib/tailscale
  if [[ -s /root/tailscale.tgz ]]; then
    tar -xzf /root/tailscale.tgz -C /usr/local/bin --strip-components=1 --wildcards '*/tailscale' '*/tailscaled'
    rm -f /root/tailscale.tgz
  fi
  if ! systemctl is-active --quiet mend-tailscaled; then
    systemd-run --unit=mend-tailscaled --property=Restart=on-failure --quiet \
      /usr/local/bin/tailscaled --statedir=/var/lib/tailscale --socket=/run/tailscale/tailscaled.sock \
      --tun=userspace-networking
  fi
  for _ in $(seq 60); do tailscale status --json >/dev/null 2>&1 && break; sleep 0.5; done
  if [[ -s /run/mend-tailnet-authkey ]]; then
    up=0
    tailscale up --auth-key=file:/run/mend-tailnet-authkey --hostname="$host" --timeout=90s >/dev/null 2>&1 || up=$?
    rm -f /run/mend-tailnet-authkey
    [[ $up -eq 0 ]] || { say "tailscale up with the auth key failed ($up)" >&2; exit 1; }
  fi
  state=
  for _ in $(seq 120); do
    state=$(tailscale status --json 2>/dev/null | jq -r .BackendState || true)
    [[ $state == Running || $state == NeedsLogin || $state == NeedsMachineAuth ]] && break
    sleep 0.5
  done
  echo "state=$state"
  case $state in
  Running) ;;
  NeedsLogin) say "the slot's node is not logged in: it never joined, or its node key expired (vm slot add, with a new key)" >&2; exit 1 ;;
  NeedsMachineAuth) say "the slot's node waits for device approval in the admin console" >&2; exit 1 ;;
  *) say "tailscale did not come up (state ${state:-none})" >&2; exit 1 ;;
  esac
  self=$(tailscale status --json | jq -c .Self)
  echo "dns=$(jq -r '.DNSName | rtrimstr(".")' <<<"$self")"
  echo "key-expiry=$(jq -r '.KeyExpiry // empty' <<<"$self")"
  caps=$(jq -r '((.CapMap // {}) | keys) + (.Capabilities // []) | join(" ")' <<<"$self")
  [[ " $caps " == *" funnel "* || $caps == *"cap/funnel"* ]] && echo "funnel=yes" || echo "funnel=no"
  [[ " $caps " == *" https "* ]] && echo "https=yes" || echo "https=no"
  crt=$(ls /var/lib/tailscale/certs/*.crt 2>/dev/null | head -1 || true)
  echo "certs=$(ls /var/lib/tailscale/certs/*.crt 2>/dev/null | wc -l)"
  [[ -z $crt ]] || echo "cert-sha=$(openssl x509 -in "$crt" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d :)"
  say "tailnet up as $(jq -r .HostName <<<"$self")"
  ;;
tailnet-funnel)
  # Mend publishes its session endpoint (13106) and bucket (13900) on this VM's loopback once Boat
  # is set up; Funnel ends TLS on the slot's own name and passes the connection through.
  tailscale funnel --bg --tls-terminated-tcp=8443 tcp://127.0.0.1:13106 >/dev/null
  tailscale funnel --bg --tls-terminated-tcp=10000 tcp://127.0.0.1:13900 >/dev/null
  say "funnel on 8443 and 10000"
  ;;
tailnet-cert)
  # Asks for the slot's certificate once; tailscaled keeps it in its state, on the slot's disk.
  name=${1:?dns name}
  t=$(mktemp -d)
  tailscale cert --cert-file "$t/c.crt" --key-file "$t/c.key" "$name" >/dev/null 2>&1 ||
    { rm -rf "$t"; say "tailscale cert $name failed" >&2; exit 1; }
  echo "subject=$(openssl x509 -in "$t/c.crt" -noout -subject | sed 's/^subject= *//')"
  echo "not-after=$(openssl x509 -in "$t/c.crt" -noout -enddate | cut -d= -f2)"
  echo "cert-sha=$(openssl x509 -in "$t/c.crt" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d :)"
  rm -rf "$t"
  echo "certs=$(ls /var/lib/tailscale/certs/*.crt 2>/dev/null | wc -l)"
  say "certificate for $name"
  ;;
tailnet-down)
  # Before the VM stops: QEMU is killed, not shut down, so what tailscaled wrote last (a new
  # certificate) reaches the slot's disk only if it is flushed and unmounted first.
  systemctl stop mend-tailscaled >/dev/null 2>&1 || true
  sync
  umount /var/lib/tailscale 2>/dev/null || true
  sync
  say "slot flushed and unmounted"
  ;;
tailnet-wait)
  # Funnel takes a few seconds to answer on a name after it is turned on; setup probes it once.
  name=${1:?dns name}
  for i in $(seq 90); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "https://$name:8443/" || true)
    [[ $code =~ ^[1-5][0-9][0-9]$ ]] && { say "https://$name:8443 answered $code after ${i}s"; exit 0; }
    sleep 1
  done
  say "https://$name:8443 did not answer in 90s" >&2
  exit 1
  ;;
boat-journals)
  # After setup turned Boat on: the build journals of the Boat images the loaded data names, which
  # sealant reads before it launches on an image and without which it quarantines the image
  # (SLNT-1252), into Boat's own state volume. vm.mjs copies them in: the master carries the ones
  # `vm save` kept with its data.
  f=/root/main-run/mend-boat-state.tgz
  [[ -s $f ]] || { say "no $f" >&2; exit 1; }
  d=$(docker volume inspect -f '{{.Mountpoint}}' mend_mend-boat-state)
  docker stop mend-mend-1 >/dev/null
  rm -f "$d"/native-builds/*.lock
  tar -xzpf "$f" --numeric-owner -C "$d"
  docker start mend-mend-1 >/dev/null
  say "$(tar -tzf "$f" | grep -vc '/$') files of Boat build journals"
  ;;
tailnet-logout)
  tailscale logout >/dev/null 2>&1 && say "logged out: the node left the tailnet" ||
    { say "tailscale logout failed" >&2; exit 1; }
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
