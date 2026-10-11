---
title: Release notes
description: What each Mend release changes, starting with 0.36.
sidebar:
  order: 3
---

Each entry says what a release changes and what it leaves as it was. Known limits stay in
[Known issues](/reference/known-issues/). Run `mend version` to see what you have.

## 0.36

Not released yet. Previews (`0.36.0-next.<n>`) carry what is below; see
[Try a preview](/getting-started/try-a-preview/).

Upgrading a server from 0.35.1: read [Upgrade to 0.36](/operate/upgrade-to-0-36/) first. Two things
need doing before the upgrade: copy out any old upgrade backup you want kept, since the upgrade now
prunes them, and rotate any token that was in an adopted repository URL. The bundled Sealant is
0.39. The VS Code extension is published with this release, as **Mend by Sealant**
(`sealant-sh.mend`) 0.36.0 on the Visual Studio Marketplace and Open VSX. The desktop app and the
native phone app are not.

### Server setup and operation

- **Guided setup.** `mend server setup` on a terminal with no flags asks its questions one at a time
  and says what it observed. Each flag now changes only what it names. `--declare` adds to the saved
  exposure statements, `--undeclare` takes one back, and `--origin none` clears the extra origins.
- **Edge and posture.** `--edge <host>` runs a Caddy TLS edge in front of Mend; `--exposure` and
  `--tenancy` declare the posture. `mend server status` reports the edge and both gates.
- **Mirrors.** An npm mirror and a Docker Hub mirror run beside Mend, on by default, in two more
  containers. See [npm mirror](/operate/npm-mirror/) and [Docker mirror](/operate/docker-mirror/).
- **Workspace SSH.** `--ssh-bind <ip>` publishes workspace SSH on its own address, a `workspace-ssh`
  item of the public exposure gate. In a per-person workspace Remote-SSH runs as the launcher, not
  root. `mend ssh keys` lists your workspace SSH keys and removes one.
- **T3 Code gateway**, opt-in with `--t3-gateway`. See [t3code](/integrations/t3code/).
- **Upgrade backups** are pruned to the newest two (`--keep-backups`).
- **Ubuntu 23.10 and later**: setup and `mend doctor` say when the host refuses user namespaces,
  with the command that allows them.
- **Docker restarts.** A workspace stops within 60 s when Docker stops, inside systemd's 90 s, so
  restarting or upgrading Docker with a live session no longer leaves Docker down for up to an hour.
  `mend doctor`'s `docker` line names any session that would outlast it.

### Sessions

- **pi and opencode** run as sessions beside Claude Code and Codex (`mend pi`, `mend opencode`), on
  your ChatGPT subscription through the Codex login. `mend connect pi` sends your pi setup. See
  [Your pi setup](/guides/pi/).
- **One model picker.** The server owns each harness's model list (`GET /api/harnesses/models`,
  `mend models`), and every session records the model and effort it started with.
- **Agent memory** for Claude Code and Codex is kept per person per project and carried into each
  session you start. `mend memory import` brings what your machine has. See
  [Agent memory](/guides/agent-memory/).
- **Secret files**: files such as `~/.aws/credentials` kept encrypted in Mend and written into every
  session you own (`mend secrets`). See [Secret files](/guides/secret-files/).
- **Automatic install**: a switch per project that runs the install command the lockfile names.
- **Several repositories in one session** with `mend repo add`. See
  [Several repositories in one session](/guides/repositories-in-a-session/).
- **Claude Code plugins** your settings and the repository's enable are installed before Claude
  starts, with no prompt. See [Claude Code plugins](/guides/skills/#claude-code-plugins).
- **Faster.** On the team's box a new session takes about 27 s (was about 90 s) and a Stop 15 to 19
  s. A Stop on Garage no longer waits 10 minutes for its upload links to expire.
- **Images.** Workspaces carry `bun` and `unzip` (each project's image rebuilds once, about +80 MB)
  and pin their harness versions. Claude Code no longer updates itself in a workspace.
- **Native Arch on arm64.** On Apple silicon and ARM servers, Arch workspaces build for `aarch64`
  instead of running `x86_64` under emulation. Reinstall native dependencies in existing worktrees
  (`node_modules`, `.venv`, `target/`); each Arch image's first build downloads the Arch Linux ARM
  rootfs (about 300 MB) from `os.archlinuxarm.org`, outside the mirrors.
- **Shallow repositories are refused** at adoption and at a session's start.

### CLI, dashboard and phone

- `mend run` works in scripts: it prints the command's output and exits with its code. `mend logs`
  and `mend wait` are new. `mend service run --wait` waits through a slow start.
- `mend pull` fast-forwards a second pull. `mend worktrees rm` removes a worktree, `--force` one
  whose change was never landed.
- The dashboard's panes are numbered (`[1]`, `[2]`, `[3]`, `[0]`), and `?` lists every key.
- The phone shows the change's pull request, asks before it stops a session, and picks models from
  the server's list.

### Credentials

- Secret files, the pi profile, memory, skills and pasted images reach a workspace through a
  single-use pickup ticket, not through Sealant's exec arguments. The bundled Sealant stores no
  process arguments and purges the ones it stored. If you ran a 0.36 prerelease, see
  [what to rotate](/operate/upgrade-to-0-36/#if-the-server-ran-a-036-prerelease).
- No saved harness state keeps a login or token another person's session could pick up. The list is
  in [How Mend handles your logins](/concepts/provider-logins/).

### Per-person workspaces, on by default

Each person who runs anything in a workspace gets their own Linux user and home, and everything they
run runs as them. `MEND_HARNESS_LAYOUT` is `person` unless set; an operator sets
`MEND_HARNESS_LAYOUT=shared` to keep new worktrees on one shared home. A worktree that has run per
person always runs per person, whatever the setting. A loopback server on the capture store (the
default `mend server setup`) runs per person too. Where a workspace cannot run per person (a nix
image, no `sudo`, a Kubernetes workspace runtime, a Docker host with no-new-privileges), a new
worktree runs with one shared home and the session says why. Hot sessions keep standbys in the
layout new worktrees run in: a per-person standby starts as its owner, with their logins in their
own home, and serves their next session in a new worktree. See
[Per-person workspaces](/operate/per-person-workspaces/).

Everyone in a per-person workspace has passwordless sudo, which runs as root: anyone working there,
and their agents, can read and change each other's files, logins included.

- **Identity and layout.** A login name, uid and home per account, the same in every workspace. The
  layout is decided before a workspace is created, from the worktree's record, what the platform
  reports for the image, and the setting. A worktree that has run per person refuses an image that
  cannot, with the reason. Codex no longer starts a new conversation when a resume cannot find its
  thread, in either layout: the turn fails with
  `Codex could not find this conversation's thread. Nothing was sent.`
- **Git and Mend identity.** Each person's `git push` signs as them, with their Mend key or their
  own bridge. Git over HTTPS to GitHub reads their own GitHub login through Mend's credential
  helper; no `GITHUB_TOKEN` is in the environment. Their Git author goes into their own home.
- **Logins.** Each person's provider logins are written into their own home and kept fresh there,
  joins included. A start whose provider is not connected is refused
  (`Connect Claude to start a session here.`). Nobody's login is used for anyone else.
- **Deliveries.** Dotfiles (scripts included), the default shell profile, skills, the pi profile,
  memory and secret files go into each person's home, as that person. A joiner's `install.sh` runs
  beside their agent unless **Start my agents after install.sh** is on.
- **Pasted images.** An image is written by the process of the person who pasted it, as them, into
  `/workspace/harness-home/people/<account id>/paste/` (0700; the image 0600). Root writes nothing
  of theirs. A first paste makes only that person's user and home: it writes none of their logins
  and delivers nothing. Each paste fetches its image with a Mend token of its own that does nothing
  else, is revoked when the paste ends however it ends, and lapses after 15 minutes in any case. In
  every layout the writer follows no link, creates the image only where nothing is, and never
  changes the mode of a directory. A `paste` directory that is a link is refused; before, it led a
  root write, and a 0755 `chmod`, outside the harness home. Slack images go the same way, as the
  person who asked; on the capture store a request that starts a session attaches none (see
  [Known issues](/reference/known-issues/)).
- **Readers.** Conversations and memory are read back per person, for the person each process ran
  as.
- **Shared steering.** Under shared control each turn runs on its sender's login, in one shared
  conversation, with no one's personal memory or instructions. A new sender waits for the previous
  sender's background work, and everyone sees what it waits for. opencode sessions cannot be shared.
- **Workspaces started before 0.36.** They keep their shared home until replaced: on their own when
  nothing would stop, or with **Replace this workspace now** (`mend workspace replace`) by the
  change's owner, always after a saved final capture. Their memory is credited server-side to the
  person who held it, or listed on the worktree as `memory from before 0.36, not credited`.
- **What the product says.** Every client shows who else is live in a workspace, the Shared control
  confirmation, the waiting line and the replacement line, in the same words. The API's session list
  and session view list the people live in each workspace.

Its performance limits, and how they are measured, are in
[Performance](/operate/per-person-workspaces/#performance).

### No credentials in repository URLs

Mend refuses a repository URL with a login or token in it (`https://oauth2:TOKEN@…`) at adoption and
for reference repositories, as it already was for dotfiles, on every client and the API, and points
to `mend keys` and the bridge instead. Before 0.36 such a URL was stored as typed and returned to
everyone who could see the project. On upgrade, Mend removes the credential from every stored
repository URL. A project whose Git store still holds one is refused until an operator removes it
(the server log names the command); the store and its worktrees are kept. Mend also strips URL
credentials from every repository URL it returns, from the Git errors it reports, and from its logs.
See [Known issues](/reference/known-issues/#projects-adopted-with-a-token-in-their-url).
