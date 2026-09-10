# Self-hosting Mend

Install the CLI on each client. Run server setup on the machine that will keep your projects. Mend
manages one application container and one official Postgres container. The application contains its
pinned Sealant runtime. Sealant's job queue runs in Postgres, and workspace images are built and
launched in the host Docker Engine through the mounted daemon socket. You choose a Mend version, not
a separate Sealant version. Session workspaces can create additional containers.

## Install and start

You need Node.js 22 or newer for the CLI. The optional terminal dashboard requires Node.js 26.
Server setup additionally needs a running local Docker daemon, Docker API 1.45 or newer, and Docker
Compose v2. Docker Engine, Docker Desktop, and OrbStack must satisfy the actual capability checks;
see the separate [macOS validation record](MACOS-VALIDATION.md).

```sh
npm install --global @sealant/mend
mend server setup
```

The npm package and POSIX installer install only the CLI. They do not install Docker or start a
server. On a remote machine, run setup there over your ordinary host SSH connection. Setup does not
provision a remote Docker daemon through an SSH or TCP Docker context.

Fresh setup pins the installed CLI version unless you supply `--version VERSION`. Use an exact
published version in place of `VERSION`. The CLI downloads that release's deployment assets and
starts its application image with `postgres:17-alpine`. Mend and Sealant have separate databases and
roles. Postgres is never installed in the application image.

Open `http://localhost:3105`. A fresh instance opens on registration: create the first account,
choose how Mend reaches your repositories (a Mend key held on the server, or your own machine's
ssh-agent), then run:

```sh
mend login --url http://localhost:3105
mend connect codex
mend connect github
mend adopt https://github.com/your-org/your-repo.git --name demo
mend codex --project demo
```

Adoption accepts a network Git URL, not a folder, `file://` URL, or path on either machine. Running
inside an existing checkout can still identify an already-adopted project. Each session gets its own
worktree in the server's store.

## Private-network access

Web and SSH bind to localhost by default. To reach a home server over a private network:

```sh
mend server setup --bind 0.0.0.0 --url http://mac-mini.local:3105 \
  --origin http://localhost:3105
```

`--url` sets the primary public origin. Repeat `--origin` for additional exact origins. Include the
scheme and non-default port, with no path. The same list governs browser authentication, CORS,
HTTP/WebSocket origin checks, pairing, and advertised URLs. Mend does not trust arbitrary Host or
Forwarded headers, discover interface addresses, or accept wildcard origins.

Binding `0.0.0.0` exposes web and SSH on every IPv4 interface. Configure your firewall or private
network yourself. Sign-up is open to anyone who can reach the server. Do not expose this default
installation to the public internet. The application has Docker socket access, which is an
administrative capability on the Docker host. Treat access to this deployment accordingly. Plain
HTTP does not encrypt client traffic; use an encrypted private network or a properly configured
HTTPS reverse proxy.

On the laptop:

```sh
mend login --url http://mac-mini.local:3105
mend connect codex
mend pair
```

Credential connection reads from that laptop. Pairing offers only configured server origins. The VS
Code extension uses the Mend URL's hostname and the advertised SSH port, not a server-local host
path. SSH configuration requires consent and a usable client key. See
[workspace SSH](WORKSPACE-SSH.md), including explicit host-key verification and rotation.

Workspace images stay in the host Docker Engine; the bundle publishes no image registry. The only
Docker requirement is the mounted daemon socket, which the application uses to build and launch
workspaces. Postgres publishes no host port.

Ports default to web `3105` and SSH `2222`. They must differ. Change occupied ports explicitly, for
example:

```sh
mend server setup --port 3205 --ssh-port 2322 --url http://localhost:3205
```

Setup reruns retain saved settings unless you explicitly change them. Changing the Docker context
requires care: volumes belong to a daemon and do not move with a context setting.

## Start, stop, inspect

```sh
mend server status
mend server logs --tail 100
mend server stop
mend server start
mend server restart
```

Status reports observations, including a health/version check when the app is running. Logs are
bounded, with no follow mode. Stop stops both product containers. Restart restarts the application
and keeps Postgres running. Start and restart reuse the saved generation and require its images
already present; they do not download a new release.

These commands never delete volumes or prune Docker resources. Stop, restart, and upgrade interrupt
web and SSH connections. Workspace containers remain, but active sessions can lose connectivity and
may need reconnection. Finish or pause important work before planned maintenance.

## Uninstall

```sh
mend uninstall            # asks: everything, the server only, or this machine's files only
mend uninstall --server   # the local installation: containers, volumes, image, configuration
mend uninstall --home     # this machine's sign-in, workspace SSH key and ~/.ssh/config block
mend uninstall --all --yes
```

The command prints exactly what will go before asking, and the server scope requires typing
`delete`: it removes the Compose containers and every volume the installation owns, including
`mend-store` (repositories, worktrees) and the database, plus the release image and the private
configuration directory's identity, generations and backups. The external volumes are removed only
when their ownership label matches this installation's identity; anything else stays and is named.
Workspace containers carry no label Mend can filter on, so they are listed with the command that
removes them. The home scope revokes this terminal's device token while the server can still answer,
then removes `cli.json`, the workspace SSH key and the managed block. Files under the configuration
directory that Mend did not create are left in place and listed.

## Offline setup

Obtain the exact release assets and images on a connected machine. Transfer the images with
`docker save` and `docker load`, preserving their canonical tags and embedded versions. Preload:

- `ghcr.io/sealant-sh/mend:VERSION`
- `postgres:17-alpine`

Put `compose.v2.yaml` and `postgres-init.sh` from that same release in a local directory, then:

```sh
mend server setup --version VERSION --assets-dir ./release-assets --offline
```

Local assets pass the same validation as downloaded assets and are copied into the private
installation. You can remove the source directory afterward. Fresh setup with local assets requires
an explicit version. Offline mode forbids release downloads and image pulls, not local health
checks. It does not make future Git, harness, or provider traffic offline.

## Upgrade deliberately

Updating `@sealant/mend` updates only the CLI. Setup reruns do not change an existing server pin. To
change the server version:

```sh
mend server upgrade --version VERSION
# Or explicitly resolve the latest release:
mend server upgrade --version latest
```

Offline upgrades accept `--assets-dir DIR --offline` with the target images preloaded. Downgrades
are refused. A same-version upgrade does not restart the app; use `start` or `restart` instead.

An installation created by an older CLI uses the `mend-docker-v1` bundle, which ran RabbitMQ and a
loopback workspace registry. Upgrade moves it to `mend-docker-v2`, which has neither: the saved
registry port is dropped, while `identity.env` is carried over byte for byte because it anchors
Docker volume ownership. Sealant 0.29.0 runs its job queue on pg-boss in Postgres and keeps
workspace images in the host Docker Engine, so dropping both services substantially reduces the
bundle's idle memory. Setup refuses to repair a v1 installation in place and points at upgrade. Any
Sealant job still queued in RabbitMQ when the upgrade runs is lost, so restart a session that was
mid-launch. Once the upgraded server is healthy, `docker volume rm mend-rabbitmq mend-registry`
reclaims the old volumes; nothing reads them again.

Upgrade validates target assets and image versions before stopping the app. It prepares an immutable
configuration generation, records recovery information, stops application writers, then streams a
private `pg_dumpall` backup containing both databases and their roles. Stop any external database
writers yourself. The dump contains credentials and must remain private.

Only a completed, fsynced backup allows target activation. Startup then runs the target's migrations
and requires the exact target version in health. Once target startup has been attempted, a failure
retains the target pin, old generation, and completed backup. Mend never automatically downgrades
the application or restores a database that may have migrated.

After such a failure:

```sh
mend server logs --tail 100
mend server status
# Correct the target's runtime problem, then retry the same pin:
mend server start --offline
```

Do not switch `active` back to an old generation as a shortcut. Old configuration files do not prove
that an old application understands a newer database. For manual recovery, first preserve current
volumes and test the completed SQL dump in an isolated compatible Postgres instance. There is no
automatic restore command.

## Data, identity, and recovery

Configuration lives at `$XDG_CONFIG_HOME/mend`, or `~/.config/mend`:

```text
mend/
  identity.env
  active -> generations/gen-UUID
  generations/gen-UUID/
    identity.env
    server.json
    server.env
    compose.yaml
    postgres-init.sh
  backups/upgrade-UUID/
    recovery.json
    database.sql
  server.lock/owner.json
```

Directories are mode `0700`; secret/configuration files and backups are `0600`. The public
`postgres-init.sh` asset is `0755` so the official image's Postgres user can execute its read-only
mount. It contains environment references, not generated credentials. Each generation is complete
and immutable. An atomic `active` symlink chooses one generation. Keep the installation identity,
generations, and Docker volumes together in backups. A database upgrade dump alone does not back up
repositories, worktrees, harness state, SSH host keys, or workspace images.

The canonical store and control volumes are external to Compose. Setup claims them using a label
whose value is the SHA-256 fingerprint of the persisted installation identity. A different
configuration directory cannot silently adopt another installation's data or replace its passwords.
Unknown, unlabelled, or mismatched data causes refusal, not initialization. Do not delete
`identity.env`, remove ownership labels, or point a fresh installation at existing volumes to bypass
that refusal. Restore the matching private configuration instead.

Commands hold an exclusive installation lock through Docker operations and health checks. Locks are
never automatically stolen. After an interrupted command, inspect `server.lock/owner.json` and
verify that its process on the recorded host and its Docker Compose children have stopped. Only then
move the lock directory aside and retry. An unreadable owner or reused PID is not evidence of a
stale lock. Keep all identity, generation, and recovery files.

An incomplete `database.sql.partial` is not a backup. After a killed upgrade, if `active` selects
the target, assume migrations may have begun and retry that target after diagnosis. If it still
selects the old generation, target startup was not reached. Never select an unreferenced prepared
generation merely because it exists.

A failed first Postgres initialization can leave a data directory that the official image will not
initialize again. Keep it and the matching identity. Diagnose the original bootstrap failure and use
explicit database recovery; rerunning setup is not permission to erase or reset that directory.

Do not run independent Compose commands or retag images concurrently with Mend. Mend's lock cannot
coordinate arbitrary Docker clients. Never use `docker compose down --volumes` or Docker prune as a
repair step.

## Scope and evidence

Docker setup is the current installer target. Kubernetes remains an
[operator-managed deployment](KUBERNETES.md); `mend server setup` does not provision it.

Linux image and installed-package checks do not establish physical MacBook-to-Mac-Mini or installed
VS Code acceptance. Those checks remain separately recorded in
[MACOS-VALIDATION.md](MACOS-VALIDATION.md). For implementation details and failure tests, see the
[CLI persistence contract](../apps/cli/SERVER-RUNTIME.md).
