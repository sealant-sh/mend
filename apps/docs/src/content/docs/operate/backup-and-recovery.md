---
title: Backup and recovery
description:
  What a Docker install keeps where, what to back up, offline setup, the server lock, how upgrades
  check and back up before they switch, and how to recover from one that failed.
sidebar:
  order: 8
---

This page is for the operator of a server installed with `mend server setup`. It covers what the
install keeps, how to back it up, how to set it up without a network, and what to do when a command
or an upgrade was cut short. [Install Mend](/getting-started/install/) covers setup and the everyday
lifecycle commands.

## What the install keeps

At idle, five containers run: Mend (with its bundled Sealant), Postgres, Garage, the npm mirror and
the Docker mirror. Caddy runs as a sixth when the edge is on. Session workspaces add their own
containers. Repositories, session captures, the databases and the SSH identity live in Docker
volumes. Private configuration lives at `$XDG_CONFIG_HOME/mend`, or `~/.config/mend`:

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

Directories are mode `0700`; secret and configuration files and backups are `0600`.
`postgres-init.sh` is `0755` so the official image's Postgres user can run its read-only mount; it
holds environment references, not credentials. Each generation is complete and never changes after
it is written. The `active` symlink, switched atomically, chooses one.

### Whose data a volume is

The store, control and Garage volumes are external to Compose. Setup claims them with a label whose
value is the SHA-256 fingerprint of `identity.env`. Another configuration directory therefore cannot
adopt this installation's data or replace its passwords: unknown, unlabelled or mismatched data is
refused, never initialised. Do not delete `identity.env`, remove ownership labels, or point a fresh
installation at existing volumes to get past that refusal. Restore the matching private
configuration instead.

## Back up

Back up the private configuration directory and the Docker volumes together. The installation
identity, the generations and the volumes belong to one another. The database dump an upgrade writes
is not a backup of repositories, captures, harness state, SSH host keys or workspace images.

Do not run your own Compose commands or retag images while a Mend command runs: Mend's lock cannot
coordinate other Docker clients. Never use `docker compose down --volumes` or `docker system prune`
as a repair step.

## The server lock

Every server command holds an exclusive lock on the installation through its Docker operations and
health checks. A lock is never taken over automatically. After a command was interrupted:

1. Read `server.lock/owner.json`.
2. Check that its process on the recorded host, and its Docker Compose children, have stopped.
3. Only then move the `server.lock` directory aside and run the command again.

An unreadable owner or a reused process id does not prove a lock is stale. Keep every identity,
generation and recovery file.

## Offline setup

On a connected machine, get the release's assets (`compose.v2.yaml` and `postgres-init.sh`) and its
images. Move the images with `docker save` and `docker load`, keeping their canonical tags. Preload:

- `ghcr.io/sealant-sh/mend:VERSION`;
- `postgres:17-alpine` and `dxflrs/garage:v2.4.1`;
- the network guard image the Mend image names, and the mirrors' images while the mirrors are on;
- the edge's image when the edge is on.

Setup names any image it still needs as `Preload <image> before continuing`. Then:

```sh
mend server setup --version VERSION --assets-dir ./release-assets --offline
```

Local assets pass the same checks as downloaded ones and are copied into the installation, so the
source directory can go afterwards. A fresh setup from local assets needs an explicit version.
`--offline` forbids release downloads and image pulls, not local health checks. It does not take
Git, harness or provider traffic offline.

## Upgrades

Updating `@sealant/mend` updates only the CLI. A setup rerun keeps the server's version. To change
it:

```sh
mend server upgrade --version VERSION
mend server upgrade --version latest
```

An offline upgrade takes `--assets-dir DIR --offline` with the target's images preloaded. A
downgrade is refused. An upgrade to the same version does not restart Mend; use `start` or
`restart`.

### What an upgrade checks first

Before anything stops, the upgrade checks the target's assets and image versions. It then compares
the migrations Mend's and Sealant's databases have applied with the list the target image carries in
`/app/migrations.txt`, and refuses, naming each one, when the target lacks a migration, changed one
(Sealant's, by drizzle's hash), or would skip one (a Mend migration below the highest id applied).
It cannot see a Mend migration changed under the same id and name.

A server on a preview numbered before the next channel (`0.36.0-preview.K`) sorts above every next
build of that version, so a plain upgrade to `0.36.0-next.N` is refused as a downgrade. Add
`--from-preview` to move it once. A failure before the target starts brings back the preview's
image.

### Backup, then the switch

The upgrade writes a new generation, records recovery information in `recovery.json`, stops Mend's
writers, and streams a private `pg_dumpall` of both databases and their roles to `database.sql`.
Stop any writer of your own first. The dump holds credentials; keep it private.

Only a complete, fsynced dump lets the target start. Startup runs the target's migrations, and the
upgrade then waits for health to report exactly the target version. Once the target has started, a
failure keeps the target pin, the old generation and the dump. Mend never downgrades itself or
restores a database that may have migrated.

### Recover from a failed upgrade

```sh
mend server logs --tail 100
mend server status
# fix the target's problem, then start the same pin again:
mend server start --offline
```

Do not point `active` back at an old generation as a shortcut. Old configuration does not prove that
old code understands a newer database. To recover by hand, first keep the current volumes, then test
the dump in a separate Postgres of a compatible version. There is no restore command.

After an upgrade was killed:

- `database.sql.partial` is not a backup.
- If `active` names the target generation, assume migrations may have started. Find out why it
  stopped, then retry that target.
- If `active` still names the old generation, the target never started.
- Never select a prepared generation that nothing refers to just because it exists.

A first Postgres start that failed can leave a data directory the official image will not initialise
again. Keep it and the matching identity, find out why the first start failed, and recover the
database explicitly. Running setup again does not erase or reset that directory.

### Which backups an upgrade removes

Each `recovery.json` holds a `sequence`, one more than the highest in `backups/`, and
`"state": "pending"` until the target answers health at its version, then `"completed"`. Only then
does the upgrade prune: it keeps the two newest completed backups by sequence, its own included,
removes older completed ones and prints each with the space it freed. `--keep-backups N` changes the
count, and `--keep-backups 0` keeps all. A failed upgrade removes nothing.

These are never removed:

- a pending backup;
- one with `database.sql.partial`, without `database.sql`, or whose dump does not end with
  `pg_dumpall`'s `dump complete` line;
- a link;
- any directory that is not `upgrade-UUID` holding exactly `recovery.json` and `database.sql`.

A removal renames the directory to `upgrade-UUID.removing` and then deletes it, so one a crash cut
short is finished next time.

Records written before 0.36 carry no state and no sequence. The first upgrade on 0.36 or later
treats each one whose dump is whole as completed and keeps only the newest N. They sort below every
sequenced record, then by the version their target generation pins, then by the generation chain (an
upgrade from the generation another targeted came after it), and only then by time. That includes
the backup of an old upgrade that failed after its target started, which looks the same on disk as
one that succeeded. Copy any you want to keep out of `backups/` before upgrading. Their removals end
in `· from before 0.36, no recorded outcome`.

A record with no outcome that an older CLI wrote after a 0.36 one (it chains from a sequenced
record's target, or pins a later version) is kept and listed as `no recorded outcome`. So is a
record with a state but no valid sequence. An `upgrade-UUID` entry the CLI cannot read is listed as
`unreadable`. Neither refuses an upgrade.

### Upgrading an old install

An install made by an old CLI uses the `mend-docker-v1` bundle, which ran RabbitMQ and a loopback
workspace registry. The upgrade moves it to the current bundle, which has neither: the saved
registry port is dropped, and `identity.env` is carried over byte for byte because it anchors volume
ownership. Setup refuses to repair a v1 install in place and points at upgrade. A Sealant job still
queued in RabbitMQ when the upgrade runs is lost, so restart a session that was starting. Once the
upgraded server is healthy, `docker volume rm mend-rabbitmq mend-registry` reclaims the old volumes.

An install from before the capture store has no Garage. The upgrade claims the `mend-garage` volume
under the same identity, derives Garage's settings from that identity, starts Garage and lays out
the bucket before Mend comes up. Nothing is migrated ahead of time. A worktree made under the old
store keeps its directory in `mend-store`, and the first launch or resume of a session in it records
capture 0 from that directory's files, uncommitted edits included. Sessions running across the
upgrade are stopped by it as usual and resume the same way.
