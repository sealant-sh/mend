# Server persistence and runtime contract

Setup and lifecycle commands share one installation directory, normally `$XDG_CONFIG_HOME/mend` or
`~/.config/mend`. This layout replaces the unreleased flat setup layout. It does not migrate a flat
installation or generate replacement credentials for one.

## Layout

```text
mend/
  server.lock/owner.json           # PID, hostname, random ownership token; present while busy
  identity.env                    # write-once installation credentials
  active -> generations/gen-UUID  # the only deployment commit point
  generations/
    gen-UUID/
      identity.env                # exact copy of the installation identity
      server.json                 # pin, context, endpoint, socket source, exposure
      server.env                  # complete Compose interpolation inputs plus credentials
      compose.yaml
      postgres-init.sh
  backups/
    upgrade-UUID/
      recovery.json               # exact previous and target generation paths, recovery policy
      database.sql.partial        # incomplete dump, never used for recovery
      database.sql                # only published after successful pg_dumpall and fsync
```

Directories are private, mode `0700`. Credentials and config files are `0600`, including
`identity.env`, `server.env`, `server.json`, and `compose.yaml`. The public `postgres-init.sh` is
`0755`, even under a `077` umask. It contains only environment references, not credential values,
and Compose bind-mounts that file read-only. The official `postgres:17-alpine` entrypoint runs it as
the container's `postgres` user, UID 70, not the host owner. Mode `0700` denies that user access.
The individual file mount does not expose its private host parent directories.

Generation immutability is an application rule: Mend never rewrites a generation. The owner can
still edit files, so reads validate config, secrets, identity consistency, and the asset contract.
Backups must protect these credentials and include the Docker volumes. Do not log raw store files.
`readServerInstallation` returns only parsed configuration and the immutable directory path.

## Transaction and recovery

`withServerStore(configDir, callback)` acquires the exclusive `server.lock` directory before any
installation reads, secret generation, or Docker calls. It holds ownership until the callback
finishes, including Compose and health checks. Other processes fail with owner and recovery
information. Handles cannot be used after release. Cleanup checks directory identity and the owner
token and never recursively deletes a lock.

No lock is automatically stolen. After a killed command, verify that the recorded process on the
recorded host **and its Docker Compose children** have stopped. Only then move `server.lock` aside
and retry. An unreadable owner, foreign host, reused PID, or inaccessible process is not proof of a
stale lock. Do not remove `identity.env`, `active`, generations, or volumes to recover a lock.

`ServerStore.prepare(files)` performs these steps while locked, without changing `active`:

1. Refuse an identity different from the saved identity.
2. Return the active generation unchanged when all file contents match and `postgres-init.sh` has
   mode `0755`. Incompatible init permissions require a new immutable generation, even for identical
   contents. Preserve the saved identity, old generation bytes and modes, and active pointer until
   activation. Never repair permissions by changing a retained generation.
3. On the first preparation, write and fsync a private identity file, then publish it using an
   exclusive hard link. Never rename over an existing identity. Fsync the installation directory.
4. Write the full generation with exclusive file creation. Fsync each file, the generation
   directory, its parent, and the installation directory.

`ServerStore.activate(generation)` checks that the retained generation belongs to this installation
and still contains the complete prepared files. It creates a temporary relative symlink, atomically
renames it over `active`, then fsyncs the installation directory. `commit(files)` remains the
combined prepare-and-activate operation for callers that need it.

Setup prepares first, runs read-only `docker compose config --images` against that exact generation,
then inspects the canonical images. Online setup pulls missing images explicitly and inspects them
again; the pull inherits the terminal's stdout so Docker's own layer progress is visible, while
stderr stays captured for the error report. Every phase that can take minutes (release lookup, asset
download, pull, Compose start, health wait) prints one line before it begins. Only after all image
checks pass does setup activate and start Compose. Both online and offline startup use
`--pull never --no-build`, so startup cannot replace a checked image by pulling or building. Image
rejection leaves any old active generation and running containers untouched.

The Docker ownership claim integration point is after durable preparation and read-only config
checks, before image checks that may pull. `server-docker-volumes.ts` owns the claim protocol.

An interruption before activation leaves the old active generation intact. On first installation,
the independently saved identity survives even if no generation was activated. Rerunning uses that
identity without generating credentials again. Partial generations and temporary files are retained,
never selected implicitly or removed automatically. Missing or corrupt identity with existing state
is an error, not permission to regenerate credentials.

An interruption after activation leaves a complete selected generation. Compose or health failure
also retains it. Retrying `up` uses the same project, volumes, pin, and credentials. There is no
claim that the filesystem transaction and Docker startup are atomic together.

### Partial Postgres initialization

The official Postgres image runs init scripts only for an empty data directory. The old `0700`
script could fail with `Permission denied` after `initdb` had already written `PG_VERSION`. A retry
can then skip initialization while the `mend` or `sealant` role and its database are still missing.
A healthy Postgres process alone does not establish that either application database exists.

Rerunning setup with the fixed CLI prepares a `0755` generation using the same credentials. It does
not reset Postgres, restore a backup, or automatically replay the init script against existing data.
Retain all database contents, even when the first initialization failed.

Manual recovery requires an operator:

1. Confirm the saved Docker context, installation identity, and owned Postgres container. Inspect
   its logs for the init failure. Keep `identity.env` and all generations.
2. Stop application writers and take a database backup or a consistent volume snapshot before
   changing database state. Do not remove volumes, clear `PGDATA`, or delete `PG_VERSION` to force
   initialization.
3. Inspect both roles and databases as the existing Postgres administrator. If bootstrap is
   incomplete, review the new generation's init script and explicitly run it inside that owned
   Postgres container with the saved administrator and application password environment. The script
   creates missing roles/databases and sets role passwords; it does not repair an existing
   database's ownership or migrate application schemas. Resolve any such conflicts separately.
4. Verify password-authenticated connections as `mend` to `mend` and as `sealant` to
   `sealant_control_plane`, including database ownership, before restarting application writers. If
   the cluster itself cannot start, retain it and use operator-directed Postgres recovery.

This is a local POSIX-filesystem protocol for Linux/macOS, not a distributed lock. The Docker
ownership claim below rejects different identities targeting the same fixed `mend` project and
canonical volumes. Keep one configuration directory per daemon. Copies of the same identity pass
ownership verification but do not share a filesystem lock; do not operate those copies concurrently.

## Lifecycle integration

Use these existing owners rather than duplicating setup internals:

- `server-store.ts`: `withServerStore`, `ServerStore.readIdentity`, `readActive`, `prepare`,
  `activate`, and `commit`. Store operations and the lock callback return `ServerStoreResult`
  values. Keep all operations on an installation, including start/stop/status/logs/upgrade, inside
  this lock scope.
- `server-setup.ts`: `readServerInstallation(store)` validates the active deployment and returns
  `{ config, directory }` or ordinary absence. `nodeServerRuntime()` captures the host environment
  once and provides the real process and HTTP implementations. The older `nodeServerSetupRuntime`
  name remains an alias.
- `server-runtime.ts`: `serverComposeArgs({ directory, dockerContext }, command)` supplies the
  explicit context, project `mend`, project directory, env file, and Compose file. Always pass the
  immutable directory from the selected generation, not the moving `active` symlink.
  `runServerProcess` is the controlled child-process implementation. Every command defaults to a
  30-second deadline. `{ timeoutMs }` selects a finite operation-specific budget. Expiry sends
  SIGKILL to the child's owned POSIX process group and waits for `close` to reap the direct child
  and drain inherited pipes before returning. Descendants cannot keep running after the caller
  releases its lock. The host init reaps orphaned descendants. Captured stdout is bounded to 4 MiB
  and stderr to 64 KiB; overflow terminates the group and returns failure. Setup allows ten minutes
  for online image pulls plus three minutes for startup, or just three minutes offline. Compose also
  receives `--wait-timeout 120`. Lifecycle startup has three minutes, stop has 90 seconds,
  release-image pulls have ten minutes, and `pg_dumpall` has fifteen minutes. A private stdout file
  does not disable the deadline or stderr limit. It is fsynced and closed after process termination,
  including on failure; incomplete output remains a private partial file.
- `server-docker-volumes.ts`: setup calls
  `claimServerDockerVolumes(runtime, { dockerContext, identityBytes })` with
  `Buffer.from(generation.files.identity)` after preparing the complete generation, before any
  Docker mutation other than the claim itself or any Compose deployment command. Read-only
  capability checks and offline image inspection can precede persistence.

### Lifecycle ownership verification

Every lifecycle command calls `verifyServerDockerVolumes` under `withServerStore`, after validating
its selected installation and reading exact persisted `identity.env` bytes through `ServerStore`.
Verification precedes lifecycle Compose calls. Missing identity, missing volumes, conflicting
labels, and failed inspections are errors. Lifecycle commands never fall back to the claim helper.
Status and logs perform read-only ownership checks and never allocate Docker resources.

`startInstallation` reports success only after exact-version health, including upgrade startup and
old-app recovery before target startup. There is no post-health Engine roundtrip: workspace images
live in the host Engine and the bundle publishes no registry. A health failure after target startup
retains the target pin, just like a startup timeout.

Low-level store file values are private serialized bytes. Upgrade parses and renders its complete
proposed config/env pair, preserves identity bytes, then uses `prepare` to fsync an immutable target
without selecting it. `activate` verifies retained files and switches the pointer without copying or
rewriting the selected generation. `createBackup` owns private recovery directories and the durable
publication of completed dumps. These extend the existing store rather than introducing a second
filesystem transaction implementation. Version policy and orchestration stay in `server-setup.ts`.
Retaining old files is not proof that the old application can run against newer database contents.

The extraction keeps filesystem ownership and publication in `server-store.ts`, process policy in
`server-runtime.ts`, and setup decisions/validation in `server-setup.ts`. The previous private
four-file writer could not safely be reused by lifecycle commands.

## Lifecycle commands and upgrade recovery

```sh
mend server status
mend server logs --tail 100         # 1..1000 lines per service; no follow
mend server stop                    # stops Mend and Postgres, not workspaces
mend server start --offline         # reuses the active generation and pin
mend server restart --offline       # stops Mend only, leaves Postgres running
mend server upgrade --version 0.24.0 --assets-dir ./release-0.24.0 --offline
mend server upgrade --version latest # explicit GitHub resolution and pull of missing images
```

Start and restart never download assets or pull release images, with or without `--offline`. They
require preloaded images with the saved version label and exact-version health. Status and logs hold
the same lock but never rewrite configuration, change permissions, or start containers. Status
reports stopped containers without making a health claim. If Mend is running, one bounded health
request must match the saved pin. Missing installations produce a readable error without creating a
configuration directory or running setup.

Updating the CLI does not change an existing server pin. Setup repairs the same version; a changed
`--version`, including `latest`, directs the user to upgrade. Upgrades require `--version`; latest
is never implicit. Semver precedence, including prerelease identifiers, determines downgrade
refusal. A same-version upgrade does nothing and directs startup retries to `mend server start`.

Upgrade proceeds under the installation lock:

1. Validate target assets and the complete proposed config/env pair. Inspect the canonical image and
   require its `org.opencontainers.image.version` label to equal the exact target. Online upgrades
   pull only missing images; offline upgrades never pull or contact GitHub. Verify both Compose
   generations resolve to only the canonical Mend pin and official `postgres:17-alpine`.
2. Fsync a prepared target generation, leaving `active` unchanged. Record the old and target paths
   in a private `backups/upgrade-UUID/recovery.json` before stopping anything.
3. Warn about interruption, stop Mend's app writers, and ensure official Postgres is running. Run
   `docker compose ... exec -T postgres pg_dumpall --username=postgres`. The production process
   runtime passes stdout directly to an exclusively created `0600` file, not a buffered string. Only
   successful, nonempty, fsynced output becomes `database.sql`; failed partial files remain private
   and are not backups. Stop external database writers before upgrading: pg_dumpall takes
   per-database consistent snapshots while Mend's writers are stopped, not a cross-database snapshot
   in the presence of unrelated writes. PostgreSQL stays running for the dump.
4. Activate the target only after the backup completes. This is the write-ahead migration boundary.
   Start it with `--pull never --no-build`, bounded Compose wait, and exact-version health.

If assets, images, generation preparation, or recovery-directory creation fail, the old pin and app
are untouched. If stop, backup, or activation fails or times out before target startup, reselect the
exact old generation and attempt to recover the old app only if it was running before the upgrade.
Recovery failure is reported with `mend server start` guidance. If Postgres was stopped, a failed
backup may leave Postgres running; it does not start a previously stopped app.

Once target startup has been attempted, any failure retains the new target, old generation, and
completed backup. **Never automatically downgrade or restore the database.** Run:

```sh
mend server logs --tail 100
mend server status
# Fix the target image/runtime problem without changing the pin, then:
mend server start --offline
```

After a killed upgrade, recover the lock only as described above. If `active` selects the target,
assume migrations may have begun, even if no successful startup was recorded. Keep all recovery
files and retry that target after diagnosis. If `active` still selects the old generation, target
startup was not reached and `mend server start --offline` retries the old app. Do not select an
unreferenced prepared generation just because it exists.

A manual database recovery is an operator decision: stop Mend, preserve the current database and
volumes, test the completed SQL dump in an isolated compatible PostgreSQL cluster, and assess the
application/migration compatibility before directing any application at the restored database. There
is intentionally no automatic restore or rollback command. The SQL dump includes role credentials
and both Mend and Sealant databases; do not share it or raw generation files. It is a database
backup, not a backup of workspace/store or other volumes. Back those up separately.

Stop/restart/upgrade interrupt web and SSH connections. Mend does not delete or stop workspace
containers, but active work can lose connectivity and may need reconnection. None of these commands
deletes volumes, calls `down -v`, or prunes Docker resources. Do not run another Compose client or
mutate image tags concurrently with Mend; the filesystem lock coordinates Mend commands, not
arbitrary Docker clients.

## Docker and health

The process environment is an allowlist: `PATH`, `HOME`, `USER`, `LOGNAME`, `XDG_CONFIG_HOME`,
`XDG_RUNTIME_DIR`, `DOCKER_CONFIG`, `SSH_AUTH_SOCK`, `TMPDIR`, `TMP`, and `TEMP`. All interpolation
variables, `COMPOSE_*`, `DOCKER_HOST`, `DOCKER_CONTEXT`, and `DOCKER_API_VERSION` from the shell are
excluded. Docker configuration files and explicitly selected contexts still supply connectivity and
credential helpers. Commands use argv arrays, never a shell. Changing a shell variable is not an
upgrade or exposure mechanism.

Linux Docker Desktop is identified from the selected daemon's `OperatingSystem`, with the standard
`desktop-linux` context also recognised. Desktop and macOS runtimes mount the daemon-side
`/var/run/docker.sock`, not the host context proxy. Local Linux Engine uses its Unix endpoint.
Detected sockets are recalculated on reruns. An explicit `--docker-socket` is recorded as an
override and retained unless the context is replaced or another override is supplied. The mounted
daemon socket is the only Docker requirement: the application builds and launches workspace images
through it, so there is no published registry a runtime has to reach.

Before activation, the resolved Compose images must be exactly `ghcr.io/sealant-sh/mend:VERSION` and
`postgres:17-alpine`. The Mend image must carry `org.opencontainers.image.version` equal to the
requested pin, even for online setup and even after a pull. A cached wrong label is rejected, not
silently replaced. Asset text checks alone do not establish what Compose will run.

Success requires a 2xx `/api/health` response containing JSON with `status: "ok"` and `version`
exactly matching the saved pin. Extra health fields are allowed. HTML, malformed JSON, missing
fields, or wrong versions never produce a reachable-version claim. The image's own `HEALTHCHECK`
covers Mend web, the Sealant API, and the SSH gateway port inside the container.

### Docker data ownership

The anchor is `mend-store`. Its immutable `dev.sealant.mend.installation` label is the SHA-256 of
the exact persisted `identity.env` bytes. Setup lists resources successfully before concluding
absence, refuses unowned legacy Mend data, and creates the anchor with that label. Docker's atomic
named create preserves the first writer's labels; setup inspects afterward to establish ownership.
Only then may it claim `mend-control` with the same label. Matching retries do not recreate volumes.
Mismatches, missing labels, failed inspections, and malformed replies stop setup. Restore the
original configuration or choose a clean daemon; never delete or relabel existing data to proceed. A
similarly named container or network can coexist only when its inspected Compose label and name
prove a different project namespace, such as `mend-dev`. Exact reserved Mend names still cause
refusal, regardless of a foreign label. Unlabelled, mismatched, or inconclusive evidence never
grants an exemption; the canonical volume guards remain unchanged.

Both canonical volumes must be `external: true` in the release Compose template with their canonical
name substitutions. Setup validates that contract on downloaded, supplied, and retained assets
before Docker mutations. It accepts the release template's explicit declarations, not arbitrary
user-authored YAML. Compose owns the remaining volumes as before. Labels establish identity
continuity, not a mutex or protection against an administrator editing Docker state.

`server-docker-volumes.ts` owns Docker protocol parsing and resource cleanup rather than putting
those mechanics into setup or duplicating them in lifecycle commands. Existing setup's exception
handling remains confined to its command/store boundary; the helpers expose expected failures as
values. Error fields use explicit declarations so the existing Node strip-only child tests can
import them.

## Reproduce the checks

```sh
pnpm --filter @sealant/mend exec vitest run src/server-setup.test.ts src/server-store.test.ts src/server-runtime.test.ts src/server-docker-volumes.test.ts
pnpm --filter @sealant/mend exec vitest run --testTimeout=15000
# Opt-in real Engine checks use unique test names, never the standard Mend resources:
MEND_DOCKER_TEST_CONTEXT=default pnpm --filter @sealant/mend exec vitest run src/server-docker-protocol.test.ts
pnpm --filter @sealant/mend exec vitest run src/server-setup.test.ts src/server-store.test.ts src/server-runtime.test.ts src/server-lifecycle.test.ts src/help.test.ts
# Preload official postgres:17-alpine in a local daemon that can bind-mount this worktree's temp files:
MEND_DOCKER_TEST_CONTEXT=default pnpm --filter @sealant/mend exec vitest run src/server-postgres-bootstrap.test.ts
pnpm --filter @sealant/mend typecheck
pnpm --filter @sealant/mend lint
pnpm format:fix
```

Tests spawn separate setup processes, kill an owner, impose a real kernel file-size limit and
terminate after a partial write, exercise write-permission failures, retain earlier generations, and
compare saved credentials across retries. Real HTTP listeners test the health response body. The
Compose test launches the production runtime in a separate process with a poisoned environment and
uses `docker compose config --format json`. Public-command rejection tests use real
`docker compose config --images` with wrong Mend pins, unexpected images, and wrong OCI labels in
online and offline setup. Process-edge fakes record pulls and starts and verify the old active
generation remains selected until image checks pass. These tests need the Compose plugin, but no
daemon or containers, and are explicitly skipped if the plugin is absent.

Public `serverCommand` tests share `test-fixtures/docker-protocol.ts`, a stateful Engine protocol
fixture with immutable named-volume labels and distinct local/remote image tags. They check
persist-before-mutation ordering, cross-config identity rejection, same-identity retries, and
corruption without mocking modules. The separate opt-in Docker tests check atomic claims and
competing identities. The separate official-Postgres test mounts the store-generated init file
read-only, uses a uniquely named and labelled container with tmpfs data and no published ports, and
checks password-authenticated connections and ownership for both databases and roles. It creates the
container before starting it, verifies its ownership label, and cleans up only the acquired
container ID. It never uses canonical Mend resources or removes the cached image. Store regressions
also cover a `077` umask and same-content retries with incompatible init modes. The full CLI suite
needs a 15-second test budget for existing login polling.

`test-fixtures/docker` copies the Compose and ownership contract from
`../Mend-packaging/deploy/docker` at `91e1cf6`; Postgres init is unchanged from `1c2018b`. These are
test inputs, not shipped CLI assets. Setup downloads the two assets from the selected GitHub release
unless `--assets-dir DIR` supplies `compose.v2.yaml` and `postgres-init.sh`. Supplied files pass the
same contract checks and are copied into the private generation. The source directory is not
retained or needed on reruns. Fresh setup with local assets requires an explicit `--version`.

Lifecycle tests invoke public `serverCommand` with the production process runtime, a separate local
Docker protocol fixture executable, real HTTP listeners and real files. They check order, exact
pins/generations, failure recovery, ownership under lock, read-only status/logs, backup permissions
and no rollback after target startup. A real stalled dump with an inherited-pipe descendant must
terminate before old-app recovery and lock release. A real target startup timeout must retain the
target. Runtime tests stream a 16 MiB dump directly to disk and exercise exclusive creation, partial
failure and bounded capture. These are deterministic protocol tests, not a claim of live
image/migration acceptance. That acceptance uses two genuinely stamped canonical candidate images
and the public CLI flags above; changing a health response to an invented version is not an upgrade
test.

`--offline` forbids GitHub requests and runs Compose with `--pull never --no-build`. Preload both
`postgres:17-alpine` and `ghcr.io/sealant-sh/mend:VERSION` in the selected daemon. The Mend image's
`org.opencontainers.image.version` label and the health response must equal the exact pin. Local
health checks still run; offline setup pulls nothing at all. This flag controls installation network
access, not the running server's workspace/provider traffic.

`--port` persists the web port, default `3105`, and `--ssh-port` the SSH gateway port, default
`2222`. Both must be valid and distinct. The bundle publishes no other host port:

```sh
mend server setup --version 0.24.0 --assets-dir ./release-assets --offline --port 3205 --ssh-port 2322
mend server setup --offline
```

No release upload, image build, or live deployment acceptance is included in these unit checks.
