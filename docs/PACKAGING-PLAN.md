# Mend packaging plan

Decided 2026-09-05. This replaces the earlier separate-service Compose proposal.

## Installation contract

```sh
npm install -g @sealant/mend
mend server setup
```

The npm package and POSIX shell bootstrap install only the CLI. A future Homebrew package follows
that same contract. Installing or upgrading the CLI does not start, install, or upgrade a server.

`mend server setup` creates the server through the selected Docker context. Docker Desktop and
OrbStack use the same Docker adapter. Kubernetes setup comes later.

At idle, `docker ps` shows two product containers:

- `mend`: Mend API/web, Sealant API/worker/SSH gateway, and their supporting services.
- Postgres: the official Postgres image, with separate Mend and Sealant databases and users.

Session workspace containers may appear while workspaces exist. Mend images contain no Postgres
server.

Superseded 2026-09-09: this section originally kept RabbitMQ and a workspace registry inside the
Mend application container. Sealant 0.29.0 removed both — its job queue is pg-boss in Postgres and
workspace images live in the host Docker Engine — so the bundle ships neither.

Users choose a Mend version. That release pins its Sealant dependency internally. Setup creates the
volumes and supplies Sealant's storage mappings automatically; users do not edit environment
variables or Compose files.

## Storage and network

Repositories, worktrees, harness state, and session sockets live in Docker-managed volumes. The
application and workspace containers use the same canonical Git metadata paths. Sealant mounts only
the granted subdirectories into each workspace, preserving read-only grants. No application reads
Docker's private volume storage, and no workspace receives the entire store or a user's home.

The public Sealant 0.28.0 deployment contract supplies named-volume subpaths through
`SEALANT_DOCKER_VOLUME_MAPPINGS`, independently of `SEALANT_MOUNT_ALLOWED_STORE_ROOTS`. This
prerequisite was released after Sealant PRs [225](https://github.com/sealant-sh/sealant/pull/225)
and [226](https://github.com/sealant-sh/sealant/pull/226). The npm packages and multiarchitecture
images are published. Strict mode requires Docker client and server API 1.45 or newer.

All Unix-socket consumers run inside Docker's Linux environment, including on macOS. The Mac
connects through published web and SSH ports. The new architecture has no demonstrated
macOS-specific blocker; product acceptance on actual Macs is still required.

Exposure defaults to localhost. Private-network access is explicit. One configured primary URL and
an explicit list of alternate origins drive Better Auth, credentialed CORS, displayed URLs, and
pairing. Origins match exact scheme, host, and port. Incoming Host/Forwarded headers and discovered
container interfaces never grant trust.

The SSH client defaults to the hostname in its configured Mend URL and the server's published SSH
port. An explicit separate SSH hostname may override that default. Managed aliases are per server;
stale endpoint/key configuration is reconciled. The extension still edits SSH configuration after
user acceptance. Discovery/authentication failures do not trigger a host-path fallback.

Adoption accepts remote Git repositories, including SSH and HTTPS sources. Local paths and folder
pickers are removed. Existing-project selection, worktree creation, and joining a worktree remain.

## Persistence and lifecycle

Setup reruns preserve data, secrets, SSH host keys, selected context, and existing configuration
unless the user explicitly changes a setting. Corrupt persisted configuration fails with a clear
error rather than generating a replacement identity. Generated secret files have restrictive
permissions and are written atomically. An exclusive lock covers each operation. A write-once
identity and complete immutable generation exist before setup claims daemon storage; the active
generation changes through an atomic pointer.

The `mend-store` anchor and `mend-control` volumes carry an installation label derived from the
persisted identity. Setup refuses foreign, unlabelled, or orphaned canonical data rather than
adopting it with new credentials. Lifecycle operations verify ownership without allocating storage.

Start, stop, status, and logs act on the recorded installation and Docker context. Stopping does not
remove volumes. Server upgrades select a Mend version explicitly; upgrading the CLI alone leaves the
server version unchanged. Migration failure must be visible, and restoring an old binary is not
presented as a database rollback. Upgrade preflight checks the target before stopping writers and
streaming a private, completed cluster backup. Once target startup may have run migrations, retain
the target pin, old generation, and backup for explicit recovery. Never automatically restore or
downgrade. Postgres major upgrades are separate work.

Combining services removes the old container boundary between the worker and SSH gateway. The bundle
must document its actual process and filesystem permissions rather than claim that boundary still
exists. Control directories retained by Sealant can be reclaimed only with launchers and workspaces
stopped.

## Review sequence

Sealant's prerequisite is released. The remaining Mend branches form one `gh stack`, in this order:

1. Shared network configuration, Better Auth, CORS, displayed/pairing URLs, and the SDK pin.
2. Combined application image, supervision, migrations, and two-container Compose deployment.
3. Per-server SSH configuration, remote addressing, and URL-only adoption.
4. CLI-only bootstrap and `mend server setup`, including context selection and generated settings.
5. Server status/logs/start/stop and controlled upgrades with persistent state.
6. Packaged acceptance tests, release automation, and installation/operation documentation.

Each PR includes its own tests and is submitted ready for review, never as a draft. Forced typecheck
and lint must pass before pushing a PR branch. The maintainer merges PRs; the agent does not merge.

## Acceptance evidence

The actual packaged product, not the retired host installer, is the test target. Required checks:

- Fresh CLI installation creates no server until setup is invoked.
- Setup starts exactly two idle product containers and publishes only selected ports.
- Local and explicitly configured private origins can sign in; unlisted origins cannot.
- Adoption, a real workspace, Git metadata, harness state, session helper/socket, and review work.
- Re-running setup, replacing the application container, and upgrading preserve data and identities.
- Failure during setup or migration reports the failed operation without destroying existing state.
- A MacBook connects to a Mac Mini server through browser, CLI, and the installed VS Code extension.
- Remote-SSH installs its server, opens files, runs a terminal, forwards a port, and reconnects.

The reproducible Mac checklist is [MACOS-VALIDATION.md](MACOS-VALIDATION.md). Linux tests provide
Linux evidence. A generic volume/socket probe cannot establish macOS product or VS Code support.
