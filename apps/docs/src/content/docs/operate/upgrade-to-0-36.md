---
title: Upgrade to 0.36
description:
  What an operator upgrading a server from Mend 0.35.1 to 0.36 needs to know before, during and
  after the upgrade.
sidebar:
  order: 9
---

This page is for an operator moving a server from 0.35.1 to 0.36. What 0.36 changes for everyone is
in the [release notes](/reference/release-notes/#036). Read the whole list before you upgrade: two
items need action beforehand (old backups, and tokens in adopted repository URLs).

## The upgrade itself

Updating `@sealant/mend` updates only the CLI, and the 0.36 CLI is the one that knows what 0.36's
install looks like (its mirrors, its backup pruning). Update it first, then upgrade the server to an
exact version:

```sh
npm install --global @sealant/mend@0.36.0
mend server upgrade --version 0.36.0
mend server status
```

The upgrade still validates the target before it stops anything, writes a private database backup,
and never downgrades or restores a database on its own
([self-hosting guide](https://github.com/sealant-sh/mend/blob/main/docs/SELF-HOSTING.md#upgrade-deliberately)).
What it does on top of that, in order:

- **Sealant's argument purge.** The bundled Sealant (0.39) no longer stores the arguments a process
  or terminal started with, since they can carry secrets. Before Sealant starts, the upgrade purges
  the arguments already stored, once. On a small team's database this takes 15 to 45 seconds.
- **Migrations.** Mend's migrations run as usual. Among them: 0104 (pull request titles), 0110 (the
  Automatic install switch), 0111 (whose memory a worktree holds), 0126 (credentials removed from
  stored repository URLs) and 0127 (`bun` and `unzip` in the workspace packages).
- **Two more containers.** The upgrade adds the npm and Docker mirrors to an install from before
  them (below).
- **Backup pruning.** Once 0.36 answers health, the upgrade keeps the two newest backups and removes
  the rest (below).

A server on an old-style preview (`0.36.0-preview.K`) is refused as a downgrade; add
`--from-preview` once.

## Before you upgrade

### Copy out any upgrade backup you want kept

`mend server upgrade` now prunes its database backups. After the new version answers health it keeps
the newest two completed backups, its own included, and removes the older ones, printing each with
the space it freed. `--keep-backups N` changes the count; `--keep-backups 0` keeps all of them. A
failed upgrade removes nothing.

Backups written before 0.36 carry no outcome. The first upgrade with a 0.36 CLI treats each one
whose dump is whole as completed and keeps only the newest N, including the backup of an old upgrade
that failed after its target started. Copy any you want out of `~/.config/mend/backups/` first, or
run that upgrade with `--keep-backups 0`. Their removals end in
`· from before 0.36, no recorded outcome`.

### Rotate tokens that were in repository URLs

Before 0.36, a repository URL adopted with a login or token in it (`https://oauth2:TOKEN@…`) was
stored as typed and returned to everyone who could see the project: on a shared project, the whole
organization. The upgrade removes the credential from stored URLs (migration 0126), but treat every
such token as exposed and rotate it. Note which projects rely on one before you upgrade: they need a
new origin afterwards ([below](#credentials-in-repository-urls-are-removed)). An upgrade backup
taken before 0.36 still holds the old URLs.

### If the server ran a 0.36 prerelease

Secret files, pi profiles, agent memory and `mend repo add` are new in 0.36. Prereleases before the
pickup tickets passed them to Sealant as exec arguments, which Sealant stored in plaintext. The
bundled Sealant purges stored arguments when it upgrades; a database backup taken before then still
holds them. If people used such a prerelease, rotate every credential kept as a
[secret file](/guides/secret-files/), every key in a pi profile's `mcp.json`, any secret written
into agent memory, and every token in an origin added to a session with `mend repo add`. A server
going straight from 0.35.1 needs none of this: 0.35.1 passed only skills, pasted images and the
shell profile that way.

### Check your Docker host and images

- **Ubuntu 23.10 and later** refuse unprivileged user namespaces by default, and no session starts
  there until they are allowed. This was already true; 0.36's `mend server setup` and `mend doctor`
  now say so and print the command. See
  [Every session fails to launch on Ubuntu](/operate/troubleshooting/#every-session-fails-to-launch-on-ubuntu).
- **Secret files need `node`** on the image's `PATH`. Sealant's managed images carry it; a custom
  image without it gets a session line saying so.
- **A Docker host with `"no-new-privileges": true`** in `daemon.json` cannot run per-person
  workspaces (next section). New worktrees there run with one shared home and say why.
- **Restarting or upgrading Docker.** A workspace started by 0.35.1 asks Docker for 3600 s when
  Docker stops, longer than the 90 s systemd gives `docker.service`, and Docker's next start then
  waits for it. Workspaces started by 0.36 ask for 60 s. Older ones keep their timeout until they
  stop. Before you restart or upgrade Docker, run `mend doctor` on the server: its `docker` line
  names any session to stop first. See
  [Docker hangs on start after a restart or upgrade](/operate/troubleshooting/#docker-hangs-on-start-after-a-restart-or-upgrade).

## Per-person workspaces are on by default

Each person who runs anything in a workspace gets their own Linux user and home, and everything they
run runs as them, on their own logins. `MEND_HARNESS_LAYOUT` is `person` unless set. To keep new
worktrees on one shared home, set `MEND_HARNESS_LAYOUT=shared` on the server and restart it.

- **The setting decides new worktrees only.** A worktree's layout is recorded at its first
  per-person launch, and a worktree that has run per person always runs per person. There is no way
  back, and a Mend older than 0.36 cannot resume that worktree's sessions. Decide before the upgrade
  if you want `shared`.
- **The first session on an image Mend has not checked runs shared.** When neither Core nor Mend has
  a record of what an image can do, the launch runs with one shared home and its prepare checks the
  image; later launches on that image run per person.
- **What it needs:** a setuid `sudo`, `useradd` and `setfacl` in the image, ACLs on `/workspace`,
  and no no-new-privileges on the executor. nix images, Kubernetes workspace runtimes and Docker
  hosts with no-new-privileges run every new worktree with a shared home and say why.
- **Everyone in a per-person workspace has passwordless sudo.** Anyone working there, and their
  agents, can read and change each other's files, logins included.
- **Workspaces started before 0.36** keep their shared home until they are replaced: on their own
  once nothing would stop and after a saved final capture, or sooner by the change's owner with
  **Replace this workspace now** (`mend workspace replace`).

The details are in [Per-person workspaces](/operate/per-person-workspaces/).

## Every project's image rebuilds once

Workspaces now carry `bun` and `unzip`. Migration 0127 adds both to every saved managed environment
that lacks them: the instance's, each organization's and each project's own. A custom base
environment is left as it is. So each project's image rebuilds once, on its next launch, and grows
by about 80 MB. That first launch waits for the build; the session line shows its step
(`building the workspace image · step 3/12`). Standby workspaces from before are replaced, since
their image no longer matches.

On an arm64 host (a Mac with Apple silicon, an ARM server), Arch workspaces now build natively
(`aarch64`) instead of under emulation as `x86_64`. Dependencies with native modules installed in an
existing worktree (`node_modules`, `.venv`, `target/`) are `x86_64` builds: reinstall them
(`pnpm install`, `uv sync`, …). Each Arch image's first build there downloads the Arch Linux ARM
root filesystem (about 300 MB) from `os.archlinuxarm.org`, outside the mirrors.

The built-in images also pin their harness versions (Claude Code 2.1.292, Codex 0.160.1, opencode
1.18.34, pi 1.0.4), so a rebuild no longer changes which version a session runs.

## `mend server setup` asks, and its flags change only what they name

On a terminal with no flags, `mend server setup` now asks its questions one at a time: how people
reach this Mend, whether VS Code Remote-SSH reaches it from other machines, the T3 Code gateway, the
mirrors, and one organization or several. It says what it observed (Tailscale, DNS, ports 80 and
443). On an existing install it shows what is saved and lets you change one thing. It ends with the
same command written with flags, and applies only on a yes.

For scripts:

- Each flag changes only what it names, and everything else is kept from the saved install.
- A run with no terminal and no flags keeps an existing install as saved. On a fresh install it is
  refused and names the flags; `--yes` takes the defaults.
- `--origin` replaces the saved list of extra origins, and `--origin none` clears it.
- `--declare <item>` adds to the saved exposure statements, `--undeclare <item>` takes one back, and
  `--declare none` clears them.
- New in 0.36: `--edge <host>` (the Caddy TLS edge), `--exposure`, `--tenancy`, `--ssh-bind`,
  `--t3-gateway` and the mirror flags. `mend help server setup` lists them all.

See [Install Mend](/getting-started/install/) and [Deploy on a VPS](/operate/deploy-vps/).

## The npm and Docker mirrors: two more containers

`mend server setup` and `mend server upgrade` now run two mirrors beside Mend, on by default:

- an **npm mirror** (nginx caching registry.npmjs.org, capped at 10g);
- a **Docker mirror** (registry 3.1 caching Docker Hub, capped at 20g, layers kept seven days), run
  by a guard that clears it over its cap and pauses it while less than 5 GiB is free.

Neither publishes a host port. Sessions install npm packages and pull Docker Hub images through
them; a project's own npm settings win, and when a mirror is down sessions go upstream. Plan for the
disk: up to 30g plus 5 GiB free by default. `--no-npm-mirror` and `--no-docker-mirror` turn them
off; `--npm-mirror-max-size` and `--docker-mirror-max-size` change the caps. `mend server status`
reports each one as observed. See [npm mirror](/operate/npm-mirror/) and
[Docker mirror](/operate/docker-mirror/). On Kubernetes they are optional chart components,
`mirrors.npm.enabled` and `mirrors.docker.enabled`.

## Workspace SSH and its exposure

`mend server setup --ssh-bind <ip>` publishes workspace SSH on its own address, so VS Code
Remote-SSH and `mend ssh` reach workspaces from other machines while the web port stays behind the
edge. Workspace SSH published beyond loopback is its own item of the public exposure gate,
`workspace-ssh`: open until you have checked from outside who reaches the port and declared it with
`--declare workspace-ssh`. Setup refuses `--exposure public` with SSH beyond loopback until you do.

In a per-person workspace, Remote-SSH runs as the workspace's launcher, in their own home, not as
root. Workspace SSH keys can now be listed and removed (`mend ssh keys`, Settings → Workspace SSH).
See [Exposure and the public gate](/operate/exposure/) and
[Work from another device](/guides/remote-access/).

## The T3 Code gateway is opt-in

The [t3code gateway](/integrations/t3code/) lets t3code's clients pair with this Mend and see its
projects and sessions. Nothing of it runs until you turn it on with `mend server setup --t3-gateway`
(or the guided setup's question). It listens on `127.0.0.1:3120` only; reaching it from another
machine is an exposure you put in front of it, and the gate lists `t3code-gateway` until you declare
it.

## Shallow repositories are refused

A shallow repository (a `git clone --depth` copy, a CI checkout) is refused at adoption, and a
project adopted from one before is refused when a session starts on it. A session on one could never
save: its Stop read `saving` for up to 10 minutes, then `final seal not confirmed`. Run
`git fetch --unshallow` where the repository is hosted, then adopt it again. A project whose
repository has grafts is refused at a session's start too. See
[Known issues](/reference/known-issues/#shallow-repositories-are-not-supported).

## Credentials in repository URLs are removed

0.36 refuses a repository URL with a login or token in it, at adoption and for reference
repositories. Migration 0126 removes the credential from every stored repository URL. A project
whose Git store still holds one is refused for fetch, push, landing, new worktrees and launches
until an operator removes it; the server log names the command for each such project at start. The
store and its worktrees are kept.

A private repository that only cloned or fetched because its origin held a token will now fail to
clone or fetch from inside a session. Switch its origin to SSH (`git@github.com:owner/repo.git`),
which goes through Mend's Git transport, and rotate the token. See
[Projects adopted with a token in their URL](/reference/known-issues/#projects-adopted-with-a-token-in-their-url).

## Claude plugins from repository settings install without a prompt

Before Claude starts, Mend installs the plugins enabled in the person's own
`~/.claude/settings.json` and in the repository's `.claude/settings.json` and
`.claude/settings.local.json`, adding a marketplace from `extraKnownMarketplaces` when Claude does
not know it. It asks no one.

This is an accepted risk: anyone who can commit to an adopted repository can install plugin code
(hooks, MCP servers, agents) into every member's Claude sessions on it, and that code runs as the
person whose session it is. The session's first lines name what was installed, what was already
there and what was not and why. A plugin that wants to run its marketplace's command at install is
never installed. Review `.claude/settings*.json` in the repositories you adopt. See
[Claude Code plugins](/guides/skills/#claude-code-plugins).

## Cloud metadata is blocked from workspaces

On a cloud VM, `169.254.169.254` (and `fd00:ec2::254` over IPv6 on AWS) hands out the instance's own
credentials. Sessions can no longer reach it: a connection from a workspace, or from a container its
Docker service runs, is refused at once, and nothing else on the network changes. The refusal is in
place before Mend starts a session. Mend has no setting to open it for a project.

- **One more image.** The bundled Sealant adds the refusal with a small pinned busybox image, which
  `mend server setup` and `mend server upgrade` pull with the server's images. With `--offline`,
  load it first: the image is named by the Mend image's `dev.sealant.mend.network-guard-image`
  label, and setup says which one it lacks.
- **Workspaces already running at the upgrade** keep the address until they stop or are replaced.
- **Not covered:** other credential endpoints (ECS's `169.254.170.2`, EKS Pod Identity's
  `169.254.170.23`), and image builds, which run on the Docker host.
