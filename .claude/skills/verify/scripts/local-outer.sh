#!/bin/sh
# The verify skill's local outer server: a real Mend server in Docker-in-Docker on this machine, for
# proving a change when no shared outer server (the box) can take a verify run. Linux with Docker.
#
#   .claude/skills/verify/scripts/local-outer.sh up [--version <mend version>]
#   .claude/skills/verify/scripts/local-outer.sh serve <commit-ish>
#   .claude/skills/verify/scripts/local-outer.sh down
#
# `up` starts the container `st-verify-outer` (privileged docker:27.5.1-dind, the server's web on
# 127.0.0.1:23105), installs Mend <version> (default 0.36.0-next.658) with `mend server setup`,
# signs up its first account with a generated password that is never printed, and writes the CLI
# config the run uses to $MEND_VERIFY_OUTER_CONFIG/mend/cli.json (default
# ~/.cache/mend-verify/outer-cli; 0600). Use it with `export XDG_CONFIG_HOME=<that dir>`.
#
# `serve <commit-ish>` puts that commit's tree in front of the server as project `mend`, from a git
# server on the server's network. The repository is always complete: the first serve is one
# parentless commit of the tree, and each later one a commit on top of the last, so every commit's
# history is in it. Never a shallow clone: Mend's capture cannot verify a worktree whose history it
# cannot walk (a Stop then stays `saving`: `final seal · refused · unrestorable`), and adoption
# refuses a shallow repository (mend#654). It prints the served commit, the one Doctor's
# `--expect-mend` names.
#
# `down` removes the container with its volumes (Docker-in-Docker keeps everything in one) and the
# CLI config. The evidence of runs against it lives elsewhere and stays.
set -eu
name=st-verify-outer
config=${MEND_VERIFY_OUTER_CONFIG:-$HOME/.cache/mend-verify/outer-cli}
work=${MEND_VERIFY_OUTER_WORK:-$HOME/.cache/mend-verify/outer-work}
here=$(cd "$(dirname "$0")" && pwd)
checkout=$(git -C "$here" rev-parse --show-toplevel)
inner() { docker exec "$name" "$@"; }

case "${1:-}" in
up)
  version=0.36.0-next.658
  [ "${2:-}" = "--version" ] && version=$3
  docker run -d --privileged --name "$name" -p 127.0.0.1:23105:3105 -e DOCKER_TLS_CERTDIR= \
    docker:27.5.1-dind --tls=false --host=unix:///var/run/docker.sock > /dev/null
  i=0
  until inner docker info > /dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 60 ] && { echo "local-outer: the inner Docker did not start" >&2; exit 1; }
    sleep 1
  done
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
  mkdir -p "$config/mend"
  chmod 700 "$config"
  # The first account: a generated password, kept nowhere; its token goes to the CLI config only.
  node -e '
    const { randomBytes, randomUUID } = require("node:crypto");
    const { writeFileSync } = require("node:fs");
    (async () => {
      const response = await fetch("http://127.0.0.1:23105/api/auth/sign-up/email", {
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
      writeFileSync(process.argv[1], JSON.stringify({ url: "http://127.0.0.1:23105", token, deviceId: randomUUID() }), { mode: 0o600 });
    })();' "$config/mend/cli.json"
  echo "local-outer · Mend $version on http://127.0.0.1:23105 · CLI config $config · MEND_VERIFY_OUTER_URL=http://127.0.0.1:23105"
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
  export MEND_VERIFY_OUTER_URL=http://127.0.0.1:23105
  export PATH="$here/guard:$PATH"
  if mend projects --json | grep -q '"name": "mend"'; then
    mend refresh --project mend > /dev/null
  else
    mend adopt http://outer-fixture:9080/repo.git --name mend --auth ambient --shared > /dev/null
  fi
  echo "local-outer · project mend serves $commit (tree of $(git -C "$checkout" rev-parse --short "$ref"), complete history)"
  ;;
down)
  docker rm -f -v "$name" > /dev/null 2>&1 && echo "local-outer · $name removed, with its volumes" \
    || echo "local-outer · no $name here"
  rm -rf "$config" "$work"
  ;;
*)
  echo "usage: local-outer.sh up [--version <v>] | serve <commit-ish> | down" >&2
  exit 2
  ;;
esac
