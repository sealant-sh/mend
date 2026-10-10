# The local server

`mend server` installs and runs Mend on this machine as a Docker Compose project: the Mend
application, Postgres and Garage, plus a Caddy TLS edge when one is set. `mend server setup`
installs or repairs one pinned release and prints where it answers. `status` reads the pin, the
containers and the posture, declared beside observed. `start`, `stop`, `restart` and `logs` operate
the same generation. `upgrade` moves to an explicit later version after a database backup, and
refuses a downgrade. A preview of the next release (`@sealant/mend@next`) installs and upgrades the
same way, and an old-style preview moves to the `next` channel once with `--from-preview`.

## Sub-features

- `server-setup` installs a fresh server at the CLI's version, or a named one, and prints its URL.
- `server-repair` re-runs setup on an existing install and keeps its pin, secrets and data.
- `server-exposure-flags` takes `--bind`, `--url`, `--origin`, `--port`, `--ssh-port` and refuses
  pairs that contradict each other.
- `server-edge` adds a Caddy TLS edge with `--edge <host>`, and removes it with `--no-edge`.
- `server-posture` declares `--exposure` and `--tenancy` and keeps them across reruns and upgrades.
- `server-offline` installs from `--assets-dir` and preloaded images with `--offline`.
- `server-status` prints the pin, the generation, the containers, the edge and the posture.
- `server-lifecycle` stops, starts and restarts the installation without touching its volumes.
- `server-logs` prints a bounded tail of every container's log.
- `server-upgrade` upgrades to an explicit version with a database backup and prunes old backups.
- `server-next-channel` installs a `next` preview and moves a `X.Y.Z-preview.K` server to
  `X.Y.Z-next.N` with `--from-preview`.
- `server-lock` refuses a second server command while one holds the lock.

## How to get to it (user POV)

- CLI:
  `mend server setup [--context <name>] [--version <version|latest>] [--bind <ip>] [--ssh-bind <ip>] [--url <origin>] [--origin <origin>...] [--port <n>] [--ssh-port <n>] [--edge <host> | --no-edge] [--exposure <loopback|private|public>] [--tenancy <single|multi>] [--declare <item>...] [--npm-mirror | --no-npm-mirror] [--npm-mirror-max-size <size>] [--docker-mirror | --no-docker-mirror] [--docker-mirror-max-size <size>] [--docker-hub-username <name> --docker-hub-token-stdin --docker-hub-public-only | --no-docker-hub-login] [--docker-socket <path>] [--assets-dir <dir>] [--offline]`,
  the usage block of `mend help server setup`.
- CLI: `mend server status`, `mend server start [--offline]`, `mend server stop`,
  `mend server restart [--offline]`, `mend server logs [--tail <n>]`.
- CLI:
  `mend server upgrade --version <target|latest> [--assets-dir <dir>] [--offline] [--from-preview] [--keep-backups <n>]`.
- CLI: `mend help server` and `mend help server <subcommand>` for the pages.
- Preview channel: `npm install --global @sealant/mend@next`, then `mend version`, then
  `mend server setup` (docs `getting-started/try-a-preview`, ADR 0015).
- Web, TUI, desktop, mobile, VS Code and Slack: not a surface for this feature. The web app shows
  the exposure the running server reports in its sidebar's `machine` block; that is the
  [exposure](./exposure.md) feature.

## Driving it with verify

Preconditions:

- A disposable Linux host whose Docker Engine (client and server API 1.45 or newer, Compose v2)
  holds no Mend installation and runs nothing else that matters. This is not the stack Launch makes
  for the other recipes: `mend server` always names its Compose project `mend` and its volumes
  `mend-store`, `mend-control`, `mend-garage`, so two installs on one daemon collide. Use a VM
  created for the run.
- Every `mend server` command in this recipe runs with `XDG_CONFIG_HOME=<scratch>/config` and
  `HOME=<scratch>/home`, both empty directories the run created. The installation's private
  configuration then lives under `<scratch>/config/mend`, never the owner's.
- Either the host reaches GitHub releases and `ghcr.io` (an online setup downloads `compose.v2.yaml`
  and `postgres-init.sh` for the CLI's version and pulls `ghcr.io/sealant-sh/mend:<version>`), or
  `ghcr.io/sealant-sh/mend:<v>` (labelled `org.opencontainers.image.version=<v>`),
  `postgres:17-alpine` and `dxflrs/garage:v2.4.1` are preloaded and the run uses
  `--version <v> --assets-dir deploy/docker --offline`, as `scripts/check-packaged-server.mjs` does.
  Below, `<v>` is the installed version and `<url>` is `http://localhost:3105` unless `--port`
  changed it.
- Ports 3105 and 2222 are free on the host, or the run passes free ones with `--port` and
  `--ssh-port`.

- **Help page.** Run `mend help server setup`. Stdout starts
  `mend server setup · install or repair the local Mend server` and lists every flag above under
  `options`. Exit code `0`. Run `mend help server`. The page contains a `subcommands` block naming
  `server setup`, `server status`, `server start`, `server stop`, `server restart`, `server logs`
  and `server upgrade`, followed by `see also`.
- **Refusals before Docker.** Run `mend server`. Stderr reads
  `mend: usage: mend server <setup|status|start|stop|restart|logs|upgrade> [options]`, exit code
  `1`. Run `mend server setup --bogus`. Stderr contains `Unknown server setup option "--bogus".`,
  exit code `1`. Run `mend server status`. Stderr contains
  `No Mend server is configured. Run mend server setup explicitly to install one.`, exit code `1`.
  Both arrive inside the storage wrapper described under Gotchas, for example
  `mend: Server storage operation failed: No Mend server is configured. Run mend server setup explicitly to install one.. Retain the identity and generations; fix the filesystem problem and retry.`
  On a machine with no installation, `logs` (even `--tail 0`), `stop`, `start`, `restart` and every
  `upgrade` refusal print the same `No Mend server is configured` line.
- **Contradictions refused.** These need Docker: stdout first shows
  `Using Docker context "<name>" (<endpoint>)`. Run `mend server setup --bind 0.0.0.0`. Stderr
  contains `A non-loopback --bind also requires an explicit --url.`. Run
  `mend server setup --exposure public`. Stderr contains
  `--exposure public needs the edge: add --edge <host>.`. Before either refusal setup only reads
  Docker: `docker context ls`, `docker --context <name> version`, `compose version` and `info`. Both
  exit `1`, and `<scratch>/config/mend` holds no `active` file afterwards.
- **Edge refused on a fresh install.** Still before any setup has succeeded, run
  `mend server setup --edge verify.example.com` (add the offline flags when offline). It reads the
  release assets, then stderr contains `A fresh install cannot start with the edge or as public:`,
  exit code `1`. When the daemon's shutdown-timeout is below 3600 s, stdout first shows
  `Docker shutdown-timeout is <n> s (…), below the 3600 s capture grace: …`. No container starts and
  no `active` file is written.
- **Fresh setup.** Run `mend server setup` (or
  `mend server setup --version <v> --assets-dir deploy/docker --offline`). Stdout shows
  `Using Docker context "<name>" (<endpoint>)`, `Downloading release assets for Mend <v>` (online
  only), `Starting Mend <v> containers; Docker waits up to 120s for them to report healthy`,
  `Mend <v> is reachable at <url>`, and
  `Open <url>, create the first account, then run: mend login --url <url>`. Exit code `0`. When the
  host refuses unprivileged user namespaces, one more line follows last and names the sysctl to
  change.
- **First account and sign-in.** Create the first account at `<url>` in a browser (see
  [Sign in](./sign-in.md)), then run `mend login --url <url>` with the same `XDG_CONFIG_HOME`. The
  operator's sign-in is what `status` uses to read the gates.
- **Status.** Run `mend server status`. Stdout shows `Pinned Mend <v> at <url>`,
  `Active generation: <scratch>/config/mend/generations/<id>`,
  `exposure · declared private · the default, not set on this install`,
  `tenancy · declared single · the default, not set on this install`, the `docker compose ps` table
  with `mend`, `postgres` and `garage`, `Mend <v> is reachable at <url>`, a line starting
  `exposure · observed private`, a line starting `tenancy · observed single`, then
  `multi mode gate, as the server reports each item:` and
  `public exposure gate, as the server reports each item:` with their items. Exit code `0`.
- **Declare a posture.** Run `mend server setup --exposure loopback`. It repairs in place and ends
  with `Mend <v> is reachable at <url>`. Run `mend server status`. The declared line now reads
  `exposure · declared loopback` with no "default" suffix, and the observed line reads
  `exposure · observed loopback`.
- **Repair keeps the pin.** Run `mend server setup --version 0.0.1`. Stderr reads
  `mend: Setup retains Mend <v>. Use mend server upgrade --version 0.0.1 to change the server pin.`,
  exit code `1`.
- **Logs.** Run `mend server logs --tail 20`. Stdout holds at most 20 lines per container, prefixed
  with the service name. Exit code `0`. Run `mend server logs --tail 0`. Stderr reads
  `mend: usage: mend server logs [--tail N], where N is 1..1000. Follow is not supported.`, exit
  `1`.
- **Stop.** Run `mend server stop`. Stdout reads
  `Connections will be interrupted. Workspace containers and data are retained, but active work can lose connectivity and may need reconnection. Mend does not stop workspace containers.`
  then
  `Mend, Postgres and Garage stopped. Volumes, configuration and workspace containers are retained.`
  Run `mend server status`. It ends `Mend is stopped. No health claim was made.`, exit `0`.
  `docker volume ls` still lists `mend-store`, `mend-control` and `mend-garage`.
- **Start.** Run `mend server start`. Stdout shows the `Starting Mend <v> containers…` line, then
  `Mend <v> is reachable at <url>`. Exit code `0`.
- **Restart.** Run `mend server restart`. Stdout shows the interruption line, the starting line and
  `Mend <v> is reachable at <url>`. `mend server status` afterwards shows `postgres` and `garage`
  with an uptime older than `mend`'s.
- **Lock.** While `mend server restart` runs in one PTY, run `mend server status` in another. Stderr
  starts `mend: Server is busy: <scratch>/config/mend/` and says `Never remove a live lock.`, exit
  `1`.
- **Upgrade refusals.** Run `mend server upgrade`. Stderr reads
  `mend: Upgrade requires --version TARGET. Use --version latest only to request the latest release explicitly.`
  Run `mend server upgrade --version 0.0.1`. Stderr starts
  `mend: Refusing downgrade from <v> to 0.0.1. Database migrations may not be reversible.`. Run
  `mend server upgrade --version <v>`. Stdout reads
  `Mend is already pinned to <v>. Use mend server start to retry startup; no upgrade was performed.`,
  exit `0`. Run `mend server upgrade --version <v> --keep-backups x`. Stderr reads
  `mend: --keep-backups takes a whole number: how many upgrade backups to keep, 0 for all.`. On a
  server that is not on `X.Y.Z-preview.K`, `--from-preview` is refused with a line starting
  `mend: --from-preview moves a server on X.Y.Z-preview.K to a next build`. None of these stop
  anything; `mend server status` still reads `Pinned Mend <v>`.
- **Upgrade.** Only when Launch supplies a second, higher version `<v2>`. Online, run
  `mend server upgrade --version <v2>`: it downloads `<v2>`'s release assets and pulls its image.
  Offline, with `ghcr.io/sealant-sh/mend:<v2>` preloaded and its `compose.v2.yaml` and
  `postgres-init.sh` in `<v2-assets>`, run
  `mend server upgrade --version <v2> --assets-dir <v2-assets> --offline`; without both flags the
  command reaches for GitHub. Stdout shows the interruption line,
  `Upgrade recovery files: <dir>. Keep the previous generation: <dir>`, the starting line,
  `Mend <v2> is reachable at <url>`, `Upgraded to <v2>. Retained database backup: <dir>`, and
  `Upgrade backups · removed <n> … · kept <k> (--keep-backups 2)`. `mend server status` reads
  `Pinned Mend <v2>` and the same declared posture as before.
- **Next channel.** Only when a published `next` build is in reach:
  `npm install --global @sealant/mend@next` on the disposable host, then `mend version`. The first
  line reads `mend X.Y.Z-next.N`. Installing the CLI does not move a server that already exists:
  setup keeps its pin. To see setup pin the next build, run `mend server setup` against a fresh
  install (a new disposable host, or this one after [uninstall](./uninstall.md) removed the recipe's
  server, with a new empty `XDG_CONFIG_HOME`); `mend server status` then reads
  `Pinned Mend X.Y.Z-next.N`. To move the existing install instead, run
  `mend server upgrade --version X.Y.Z-next.N`, which is refused as a downgrade when that is lower
  than its pin. A server on an old-style `X.Y.Z-preview.K` asked for `X.Y.Z-next.N` without
  `--from-preview` is refused with the downgrade line, which then names `--from-preview`; with it,
  stdout reads `ghcr.io/sealant-sh/mend:<target> carries all <n> migrations this server applied.`
  before the upgrade proceeds.
- **Proof.** Keep every command's transcript with stdout, stderr and exit code, under the
  sub-feature it proves. Keep `mend server status` before and after each mutation as the read-only
  second view, and `docker --context <ctx> volume ls` after `stop` and after `upgrade`. Report the
  edge, next-channel and upgrade steps as unreachable, with the missing precondition, when Launch
  supplies no DNS name, no published next build or no second image. Tear the install down with
  [uninstall](./uninstall.md).

## Gotchas

- Never run these steps against the owner's machine or Launch's stack. The Compose project name and
  volume names are fixed, so a second setup on a daemon that already has Mend volumes fails with
  `Docker volume ownership check failed (…)`, and a stop or upgrade there interrupts real work.
- `XDG_CONFIG_HOME` decides where the installation's configuration lives, and the CLI's sign-in sits
  in the same directory. Set it identically for `mend login`, `mend server status` and
  `mend uninstall`, or status cannot read the operator's gates and says
  `gate items · every item with its detail needs the operator's sign-in on this machine: …`.
- A fresh online setup installs the CLI's own version. A CLI built from source carries the version
  in `apps/cli/package.json`, whose release image may not exist; use `--version` with
  `--assets-dir deploy/docker --offline` and a preloaded image built from the same source.
- `--edge` makes Caddy listen on 80 and 443 of every interface and ask for a real certificate. It is
  drivable only on a disposable host with a DNS name pointing at it; otherwise `status` reports
  `edge · <host> · container running · no certificate in Caddy's data yet · mend server logs shows what Caddy tried`.
  Take it away with `mend server setup --no-edge`, which prints that the edge is gone and how to
  remove its certificate volumes. On an install that declares `public`, `--no-edge` alone is refused
  with `--exposure public needs the edge: …`, because the saved exposure is kept; pass a compatible
  one in the same command: `mend server setup --no-edge --exposure private`.
- Setup's "first account must already exist" rule is checked as "an installation already exists"
  (`apps/cli/src/server-setup.ts:1800`). Once one setup has succeeded, `--edge` is accepted on a
  rerun even when no account has been created yet, though `mend help server setup` says the first
  account must exist. The CLI cannot see accounts; a product gap to report, not to work around.
- `--exposure public` needs the edge and an existing first account; `--exposure loopback`
  contradicts a non-loopback `--bind` or an edge. Setup refuses each with one line before it writes
  a generation.
- `mend server start` never pulls release images, with or without `--offline`; a missing image is
  refused with `Preload <image> before continuing`.
- `mend server logs` has no follow mode. Wait for a status line with `mend server status`, not for
  log output.
- The shell completions lag this page: `mend completions zsh|bash` complete
  `--version --assets-dir --offline --context --port --ssh-port --bind --url --origin --docker-socket`
  for `setup` and `--version --assets-dir --offline --from-preview` for `upgrade`, and miss
  `--edge`, `--no-edge`, `--exposure`, `--tenancy` and `--keep-backups`
  (`apps/cli/src/main.ts:3895-3896`, `3925-3926`). A product gap.
- Status words are observations. `Mend <v> is reachable at <url>` means health answered with the
  exact pinned version; the gate lines say what was declared and observed, never that the instance
  is fit to expose. Report them as written.
- Every refusal raised while the server's configuration lock is held reaches stderr wrapped as
  `mend: Server storage operation failed: <refusal>.. Retain the identity and generations; fix the filesystem problem and retry.`
  (`apps/cli/src/server-store.ts:152-158`, `:1023-1024`): an unknown option, no installation, a
  contradicting flag pair, a fresh install with the edge. Match the refusal inside the line. A
  product gap: the advice names a filesystem problem that is not there, and the refusal's own period
  doubles. Only `mend server` with no subcommand prints its usage line unwrapped.
