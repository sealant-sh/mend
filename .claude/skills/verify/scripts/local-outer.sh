#!/bin/sh
# The verify skill's local outer server: a real Mend server in Docker-in-Docker on this machine, for
# proving a change when no shared outer server (the box) can take a verify run. Linux with Docker.
#
#   .claude/skills/verify/scripts/local-outer.sh up [--version <mend version>]
#   .claude/skills/verify/scripts/local-outer.sh serve <commit-ish>
#   .claude/skills/verify/scripts/local-outer.sh budgets
#   .claude/skills/verify/scripts/local-outer.sh seed
#   .claude/skills/verify/scripts/local-outer.sh down
#   .claude/skills/verify/scripts/local-outer.sh hub-cache up|down|status
#
# `up` starts the container `st-verify-outer` (privileged docker:27.5.1-dind, the server's web on
# 127.0.0.1:23105; MEND_VERIFY_OUTER_NAME, MEND_VERIFY_OUTER_PORT, MEND_VERIFY_OUTER_CONFIG and
# MEND_VERIFY_OUTER_WORK give a second verifier on this machine an outer of its own), installs Mend <version> (default 0.36.0-next.658) with `mend server setup`,
# signs up its first account with a generated password that is never printed, and writes the CLI
# config the run uses to $MEND_VERIFY_OUTER_CONFIG/mend/cli.json (default
# ~/.cache/mend-verify/outer-cli; 0600). Use it with `export XDG_CONFIG_HOME=<that dir>`.
#
# `up` then gives the server budgets sized for parallel verifiers (`budgets`, below) before the
# sign-up. Every verifier on this machine reaches it from one address with one account, and the
# product's defaults are sized for a small team: 1200 requests per minute from one address, which
# five drivers' tunnels and watches spent in seconds (429s, dropped tunnels). The product's defaults
# stay as they are; only this outer gets these.
#
# `budgets` recreates the server's `mend` container with the Compose files setup started it with
# (read from the container's own Compose labels) and one more, /st-verify/compose.budgets.yaml in
# the outer container, that sets the MEND_BUDGET_* values below; then waits for its health. Run it
# again after anything that recreates the server from setup's files alone (`mend server restart`
# or `upgrade` inside the outer).
#
# `serve <commit-ish>` puts that commit's tree in front of the server as project `mend`, from a git
# server on the server's network. The repository is always complete: the first serve is one
# parentless commit of the tree, and each later one a commit on top of the last, so every commit's
# history is in it. Never a shallow clone: Mend's capture cannot verify a worktree whose history it
# cannot walk (a Stop then stays `saving`: `final seal · refused · unrestorable`), and adoption
# refuses a shallow repository (mend#654). It prints the served commit, the one Doctor's
# `--expect-mend` names.
#
# `seed` keeps Docker Hub pulls off this machine's address, which gets 100 anonymous ones an hour
# and which every outer and every stack would otherwise spend on the same images. It loads the
# images this machine's Docker holds into the outer's daemon (`up` does this before setup), then
# fills the Docker service of every session running in the outer from the outer's daemon, which
# pulls a missing image once for all its sessions. Run it after an outer session starts and before
# its stack does (SKILL.md, Launch). It loads only a tag the daemon lacks, and only a copy whose
# digest Docker Hub still names for the tag: a stale copy is left to be pulled. When Docker Hub
# refuses to say (its limit spent), the copy is loaded and its digest printed as unchecked.
#
# `hub-cache up` starts one pull-through cache of Docker Hub for every outer on this machine,
# `st-verify-hub-cache` (registry:2, volume st-verify-hub-cache), on a Docker network of its own
# and published on no address: this machine's firewall drops what containers send to the Docker
# bridge's own address, so outers reach it by joining that network. An outer whose `up` runs with
# MEND_VERIFY_REGISTRY_MIRROR=http://st-verify-hub-cache:5000 joins it and has its daemon ask the
# cache first, so the cache pulls an image from Docker Hub once for all of them, and serves its copy
# while Docker Hub refuses. `hub-cache status` prints what it holds and Docker Hub's remaining
# pulls; `hub-cache down` removes the container and keeps the volume and the network.
#
# `down` removes the container with its volumes (Docker-in-Docker keeps everything in one) and the
# CLI config. The evidence of runs against it lives elsewhere and stays.
set -eu
# One outer per name: two verifiers on one machine each set their own name, port, config and work
# directory (the defaults are one machine-wide outer, which a second `up` collides with).
name=${MEND_VERIFY_OUTER_NAME:-st-verify-outer}
port=${MEND_VERIFY_OUTER_PORT:-23105}
config=${MEND_VERIFY_OUTER_CONFIG:-$HOME/.cache/mend-verify/outer-cli}
work=${MEND_VERIFY_OUTER_WORK:-$HOME/.cache/mend-verify/outer-work}
here=$(cd "$(dirname "$0")" && pwd)
checkout=$(git -C "$here" rev-parse --show-toplevel)
inner() { docker exec "$name" "$@"; }
mirror=${MEND_VERIFY_REGISTRY_MIRROR:-}
cache=st-verify-hub-cache

# What each daemon pulls from Docker Hub. The outer's: the image `up` runs setup in, the server's
# Compose images (the mirrors' ones too, for a version that runs them), the workspace Docker
# service's image, and the arch workspace image's bases (its build also fetches the frontend
# docker/dockerfile:1.7, which this machine lacks). A session's Docker service, for stack.mjs: its
# fixture base and Docker CLI, the Compose images, and the Dockerfiles' bases (Mend's, Core's,
# sealantd's). Not the network guard's image: stack.mjs names it by digest, which a loaded image
# does not carry, so it pulls it all the same.
OUTER_IMAGES='node:26-bookworm postgres:17-alpine dxflrs/garage:v2.4.1 nginx:1.29-alpine registry:3.1
docker:27.5.1-dind-rootless docker:27.5.1-cli archlinux:latest'
SESSION_IMAGES='node:26-bookworm node:26-bookworm-slim node:24-bookworm-slim docker:27.5.1-cli
postgres:17-alpine dxflrs/garage:v2.4.1 nginx:1.29-alpine registry:3.1 alpine:3.22 rust:slim'

# The digest Docker Hub names for a tag now, or nothing when it does not answer. A HEAD request:
# Docker Hub does not count it as a pull.
hub_digest() {
  repo=${1%:*}
  tag=${1##*:}
  case $repo in */*) ;; *) repo=library/$repo ;; esac
  token=$(curl -fsS --max-time 10 \
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$repo:pull" \
    2> /dev/null | jq -r .token) || return 0
  curl -fsS --max-time 10 --head -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json' \
    "https://registry-1.docker.io/v2/$repo/manifests/$tag" 2> /dev/null \
    | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p' || true
}

# Load each image this machine holds into one daemon, reached by the command in "$@" (`docker`
# with its arguments). Leaves a tag the daemon has, and one this machine lacks or holds stale: the
# daemon pulls those, through its mirror when it has one.
seed_into() {
  target=$1 images=$2
  shift 2
  platform=linux/$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')
  for image in $images; do
    "$@" image inspect "$image" > /dev/null 2>&1 && continue
    held=$(docker image inspect -f '{{join .RepoDigests " "}}' "$image" 2> /dev/null) || {
      echo "local-outer · seed · $target · $image · not on this machine"
      continue
    }
    repo=${image%:*}
    digest=$(echo " $held " | sed -n "s|.* $repo@\(sha256:[0-9a-f]*\) .*|\1|p")
    current=$(hub_digest "$image")
    if [ -n "$current" ] && [ "$current" != "$digest" ]; then
      echo "local-outer · seed · $target · $image · stale here ($digest; Docker Hub names $current)"
      continue
    fi
    docker save --platform "$platform" "$image" | "$@" load -q > /dev/null
    if [ -n "$current" ]; then
      echo "local-outer · seed · $target · $image · loaded $digest (current)"
    else
      echo "local-outer · seed · $target · $image · loaded $digest (unchecked: Docker Hub did not answer)"
    fi
  done
}

# A session's Docker service is the rootless daemon in its `sealant-<workspace>-docker` container,
# and Mend 0.36.0-next.658 starts it with no registry mirror. It gets each image from the outer's
# daemon, which takes it from this machine or pulls it once for all its sessions (through the
# hub-cache, when the outer runs with MEND_VERIFY_REGISTRY_MIRROR).
in_service() { docker exec -i "$name" docker exec -i -e DOCKER_HOST=tcp://127.0.0.1:2375 "$service" docker "$@"; }

seed() {
  seed_into "$name" "$OUTER_IMAGES" docker exec -i "$name" docker
  mirrors=$(inner docker info -f '{{join .RegistryConfig.Mirrors " "}}')
  for service in $(inner docker ps --filter label=sealant.workspace --format '{{.Names}}'); do
    for image in $SESSION_IMAGES; do
      in_service image inspect "$image" > /dev/null 2>&1 && continue
      if ! inner docker image inspect "$image" > /dev/null 2>&1; then
        seed_into "$name" "$image" docker exec -i "$name" docker
        inner docker image inspect "$image" > /dev/null 2>&1 || {
          inner docker pull -q "$image" > /dev/null || { echo "local-outer · seed · $service · $image · $name could not pull it"; continue; }
          echo "local-outer · seed · $name · $image · pulled (mirrors: ${mirrors:-none})"
        }
      fi
      inner docker save "$image" | in_service load -q > /dev/null
      echo "local-outer · seed · $service · $image · loaded from $name"
    done
  done
}

hub_cache() {
  case "${1:-}" in
  up)
    docker network inspect "$cache" > /dev/null 2>&1 || docker network create "$cache" > /dev/null
    if [ -z "$(docker ps -aq --filter "name=^$cache\$")" ]; then
      docker run -d --name "$cache" --network "$cache" --restart unless-stopped \
        -v "$cache:/var/lib/registry" -e REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io \
        registry:2 > /dev/null
    else
      docker start "$cache" > /dev/null
    fi
    i=0
    until docker exec "$cache" wget -q -O /dev/null http://127.0.0.1:5000/v2/ 2> /dev/null; do
      i=$((i + 1)); [ "$i" -gt 30 ] && { echo "local-outer: $cache did not answer" >&2; exit 1; }
      sleep 1
    done
    echo "local-outer · $cache on network $cache · MEND_VERIFY_REGISTRY_MIRROR=http://$cache:5000"
    ;;
  down)
    docker rm -f "$cache" > /dev/null 2>&1 \
      && echo "local-outer · $cache removed; volume and network $cache kept" \
      || echo "local-outer · no $cache here"
    ;;
  status)
    state=$(docker inspect -f '{{.State.Status}}' "$cache" 2> /dev/null || echo absent)
    echo "local-outer · $cache · $state · http://$cache:5000 on network $cache"
    [ "$state" = running ] \
      && echo "  holds: $(docker exec "$cache" wget -q -O - http://127.0.0.1:5000/v2/_catalog)"
    token=$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:ratelimitpreview/test:pull" | jq -r .token)
    echo "  Docker Hub: $(curl -fsS --head -H "Authorization: Bearer $token" \
      https://registry-1.docker.io/v2/ratelimitpreview/test/manifests/latest | tr -d '\r' \
      | sed -n 's/^ratelimit-remaining: *\([0-9]*\).*/\1 pulls left this hour/p')"
    ;;
  *)
    echo "usage: local-outer.sh hub-cache up|down|status" >&2
    exit 2
    ;;
  esac
}

# The local outer's budgets (docs/operations/budgets.md): room for at most 4 stacks live (SKILL.md)
# with a few drivers each, every one from 127.0.0.1 as the outer's one account. Sign-in attempts
# keep the product's default: no driver signs in to the outer.
BUDGETS='
MEND_BUDGET_ADDRESS_REQUESTS_PER_MINUTE=12000
MEND_BUDGET_CREDENTIAL_REQUESTS_PER_MINUTE=12000
MEND_BUDGET_ACCOUNT_LIVE_SESSIONS=120
MEND_BUDGET_ORGANIZATION_LIVE_SESSIONS=240
MEND_BUDGET_ACCOUNT_LAUNCHES_IN_FLIGHT=16
MEND_BUDGET_ACCOUNT_EVENT_STREAMS=64
MEND_BUDGET_ACCOUNT_TERMINALS=64
MEND_BUDGET_ACCOUNT_TUNNELS=64
'

budgets() {
  label() {
    inner docker inspect -f "{{index .Config.Labels \"com.docker.compose.project.$1\"}}" mend-mend-1
  }
  files=$(label config_files)
  dir=$(label working_dir)
  envfile=$(label environment_file)
  if [ -z "$files" ] || [ -z "$dir" ]; then
    echo "local-outer: mend-mend-1 carries no Compose labels; budgets not set" >&2
    exit 1
  fi
  [ -n "$envfile" ] || envfile=$dir/server.env
  inner mkdir -p /st-verify
  {
    echo "# Written by local-outer.sh budgets: the verify skill's local outer only."
    echo "services:"
    echo "  mend:"
    echo "    environment:"
    for entry in $BUDGETS; do echo "      ${entry%%=*}: \"${entry#*=}\""; done
  } | docker exec -i "$name" sh -c 'cat > /st-verify/compose.budgets.yaml'
  set --
  old_ifs=$IFS
  IFS=,
  for file in $files; do set -- "$@" -f "$file"; done
  IFS=$old_ifs
  inner docker compose --project-name mend --project-directory "$dir" --env-file "$envfile" \
    "$@" -f /st-verify/compose.budgets.yaml up -d --no-deps mend > /dev/null
  i=0
  until curl -fsS -o /dev/null "http://127.0.0.1:$port/api/health" 2> /dev/null; do
    i=$((i + 1)); [ "$i" -gt 120 ] && { echo "local-outer: the server did not answer after its budgets were set" >&2; exit 1; }
    sleep 1
  done
  echo "local-outer · $name · budgets for parallel verifiers: $(echo $BUDGETS | tr ' ' ',' | sed 's/MEND_BUDGET_//g')"
}

case "${1:-}" in
up)
  version=0.36.0-next.658
  [ "${2:-}" = "--version" ] && version=$3
  network=bridge
  set -- --tls=false --host=unix:///var/run/docker.sock
  if [ -n "$mirror" ]; then
    docker network inspect "$cache" > /dev/null 2>&1 \
      || { echo "local-outer: no network $cache: run \`local-outer.sh hub-cache up\` first" >&2; exit 1; }
    network=$cache
    # A plain-http mirror is an insecure registry too: BuildKit reaches it over https otherwise.
    set -- "$@" "--registry-mirror=$mirror"
    case $mirror in http://*) set -- "$@" "--insecure-registry=${mirror#http://}" ;; esac
  fi
  docker run -d --privileged --name "$name" --network "$network" -p "127.0.0.1:$port:3105" \
    -e DOCKER_TLS_CERTDIR= docker:27.5.1-dind "$@" > /dev/null
  i=0
  until inner docker info > /dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 60 ] && { echo "local-outer: the inner Docker did not start" >&2; exit 1; }
    sleep 1
  done
  seed_into "$name" "$OUTER_IMAGES" docker exec -i "$name" docker
  inner docker volume create outer-state > /dev/null
  state=$(inner docker volume inspect -f '{{.Mountpoint}}' outer-state)
  inner docker run --rm --network host --add-host outer.verify.test:127.0.0.1 \
    -v "outer-state:$state" -v /var/run/docker.sock:/var/run/docker.sock \
    -v /usr/local/bin/docker:/usr/local/bin/docker:ro \
    -v /usr/local/libexec/docker/cli-plugins:/usr/local/libexec/docker/cli-plugins:ro \
    -e "HOME=$state/home" -e "XDG_CONFIG_HOME=$state/home/.config" node:26-bookworm sh -c "
      set -e
      npm install -g --no-audit --no-fund @sealant/mend@$version > /dev/null 2>&1
      exec mend server setup --version $version --bind 0.0.0.0 --url http://outer.verify.test:3105 --port 3105 --ssh-port 2222" \
    | tail -n 2
  budgets
  mkdir -p "$config/mend"
  chmod 700 "$config"
  # The first account: a generated password, kept nowhere; its token goes to the CLI config only.
  node -e '
    const { randomBytes, randomUUID } = require("node:crypto");
    const { writeFileSync } = require("node:fs");
    (async () => {
      const response = await fetch(`http://127.0.0.1:${process.argv[2]}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { origin: "http://outer.verify.test:3105", "content-type": "application/json" },
        body: JSON.stringify({
          email: "owner@st-verify-outer.invalid",
          password: randomBytes(24).toString("hex"),
          name: "st-verify-outer owner",
        }),
      });
      const token = response.headers.get("set-auth-token");
      if (!response.ok || !token) {
        console.error(`local-outer: sign-up refused (HTTP ${response.status})`);
        process.exit(1);
      }
      writeFileSync(process.argv[1], JSON.stringify({ url: `http://127.0.0.1:${process.argv[2]}`, token, deviceId: randomUUID() }), { mode: 0o600 });
    })();' "$config/mend/cli.json" "$port"
  echo "local-outer · $name · Mend $version on http://127.0.0.1:$port · CLI config $config · MEND_VERIFY_OUTER_URL=http://127.0.0.1:$port"
  ;;
serve)
  ref=${2:?serve needs a commit-ish}
  tree=$(git -C "$checkout" rev-parse "$ref^{tree}")
  mkdir -p "$work"
  [ -d "$work/repo.git" ] || git init -q --bare "$work/repo.git"
  parent=$(git -C "$work/repo.git" rev-parse -q --verify refs/heads/main || true)
  commit=$(GIT_AUTHOR_NAME=Mend GIT_AUTHOR_EMAIL=verify@st-verify-outer.invalid \
    GIT_COMMITTER_NAME=Mend GIT_COMMITTER_EMAIL=verify@st-verify-outer.invalid \
    git -C "$checkout" commit-tree "$tree" ${parent:+-p "$parent"} -m "verify: $(git -C "$checkout" rev-parse --short "$ref")")
  git -C "$checkout" push -q "$work/repo.git" "$commit:refs/heads/main"
  git -C "$work/repo.git" symbolic-ref HEAD refs/heads/main
  [ "$(git -C "$work/repo.git" rev-parse --is-shallow-repository)" = false ]
  git -C "$work/repo.git" update-server-info
  tar -cf "$work/repo.tar" -C "$work" repo.git
  # A container inspect: a plain `docker inspect` also matches the volume of the same name, which a
  # first serve that failed after creating it leaves behind.
  if ! inner docker container inspect outer-fixture > /dev/null 2>&1; then
    # Right after `up` the server's container may still be restarting: wait for it to be listed.
    image=
    i=0
    while [ -z "$image" ]; do
      image=$(inner docker ps --filter name=mend-mend-1 --format '{{.Image}}')
      [ -n "$image" ] && break
      i=$((i + 1)); [ "$i" -gt 60 ] && { echo "local-outer: mend-mend-1 is not running; nothing served" >&2; exit 1; }
      sleep 1
    done
    inner docker volume create outer-fixture > /dev/null
    inner docker create --name outer-fixture --restart unless-stopped --network mend_default \
      -v outer-fixture:/fixture --entrypoint node "$image" /fixture/packaged-git-fixture.mjs > /dev/null
    # Staged under /st-verify: `docker cp` cannot write into the container's /tmp, a tmpfs.
    inner mkdir -p /st-verify
    for file in packaged-git-fixture.mjs packaged-server-assertions.mjs; do
      docker cp "$checkout/scripts/$file" "$name:/st-verify/$file"
      inner docker cp "/st-verify/$file" "outer-fixture:/fixture/$file"
    done
  fi
  inner mkdir -p /st-verify
  docker cp "$work/repo.tar" "$name:/st-verify/repo.tar"
  inner sh -c 'rm -rf /st-verify/repo && mkdir /st-verify/repo && tar -xf /st-verify/repo.tar -C /st-verify/repo'
  inner docker cp /st-verify/repo/repo.git outer-fixture:/fixture/repo.next.git
  inner docker start outer-fixture > /dev/null
  inner docker exec outer-fixture sh -c 'rm -rf /fixture/repo.git && mv /fixture/repo.next.git /fixture/repo.git && chown -R root:root /fixture/repo.git'
  export XDG_CONFIG_HOME="$config"
  # Its own `mend` calls pass the skill's guard too: this outer server and no other.
  export MEND_VERIFY_OUTER_URL=http://127.0.0.1:$port
  export PATH="$here/guard:$PATH"
  if mend projects --json | grep -q '"name": "mend"'; then
    mend refresh --project mend > /dev/null
  else
    mend adopt http://outer-fixture:9080/repo.git --name mend --shared > /dev/null
  fi
  echo "local-outer · project mend serves $commit (tree of $(git -C "$checkout" rev-parse --short "$ref"), complete history)"
  ;;
budgets)
  budgets
  ;;
seed)
  seed
  ;;
hub-cache)
  hub_cache "${2:-}"
  ;;
down)
  # Killing a Docker-in-Docker that runs containers can outlast the first `rm` ("did not receive an
  # exit event"), so try again before calling it gone.
  i=0
  while docker container inspect "$name" > /dev/null 2>&1; do
    docker rm -f -v "$name" > /dev/null 2>&1 && echo "local-outer · $name removed, with its volumes"
    i=$((i + 1)); [ "$i" -gt 12 ] && { echo "local-outer: $name would not go" >&2; exit 1; }
    sleep 1
  done
  [ "$i" -gt 0 ] || echo "local-outer · no $name here"
  rm -rf "$config" "$work"
  ;;
*)
  echo "usage: local-outer.sh up [--version <v>] | serve <commit-ish> | budgets | seed | down | hub-cache up|down|status" >&2
  exit 2
  ;;
esac
