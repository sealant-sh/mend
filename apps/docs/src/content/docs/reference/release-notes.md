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
