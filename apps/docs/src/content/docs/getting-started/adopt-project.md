---
title: Adopt a project
description: Clone a network Git repository into Mend's central store.
sidebar:
  order: 3
---

Adoption creates the Mend-owned repository used for sessions. Agents never run against your existing
checkout.

## Adopt the current repository

From a Git checkout:

```sh
mend adopt
```

Mend reads the checkout's `origin` URL and asks the server to clone that network repository. It does
not upload your local files or uncommitted changes. Without a network origin, supply a Git URL
explicitly.

Choose a name explicitly:

```sh
mend adopt --name billing-api
```

You can also adopt from the web: the Projects page has an Adopt a repository button that takes a Git
URL, an optional name, the Git access mode, and who the project is visible to.

## Adopt another source

Supply a network Git URL:

```sh
mend adopt https://github.com/acme/api.git
mend adopt git@github.com:acme/api.git
mend adopt ssh://git@example.com/acme/api.git
```

The server performs the clone. Local paths, Windows paths, `file://` sources, and custom Git remote
helpers are rejected, even if the files exist on the server. There is no folder-adoption mode.

## Choose Git authentication

`--auth` selects how the Mend host authenticates remote Git operations:

| Mode       | Behavior                                                      |
| ---------- | ------------------------------------------------------------- |
| `ambient`  | Use whatever credentials exist inside the Mend server process |
| `mend-key` | Use your Mend key, held on the server                         |
| `bridge`   | Relay signing to an SSH agent shared from another machine     |

The default is your Git access mode from `mend keys mode`, which is `mend-key` until you change it.
Ambient mode uses whatever credentials exist inside the Mend application container; the Docker
deployment ships none and never inherits your laptop's home directory or SSH agent, so ambient mode
reaches only public remotes there.

For a Mend key:

```sh
mend keys init
mend keys show
mend adopt git@github.com:acme/api.git --auth mend-key
```

Each user has one Mend key, held on the server. Add the printed public key to your Git account's SSH
keys and every repository you can reach works, from detached sessions and the phone too. For one
repository only, add it as that repository's deploy key instead, with write access only if sessions
should push or you want to land changes.

For a hardware key that stays on your laptop, adopt with `--auth bridge`. The Mend host sends SSH
signing requests back to your machine's ssh-agent. When your mode is `bridge`
(`mend keys mode bridge`), every attaching `mend` command and the dashboard share the agent on their
own for as long as they run. On a machine that is not running one, share it explicitly:

```sh
mend keys share
```

Press `Ctrl+C` to stop sharing. Read [Configure Git access](/guides/git-access/) for both modes.

## Choose who sees the project

A project is `private` or `shared`:

```sh
mend adopt --private
mend adopt --shared
```

`--private` is the default: only you see the project. `--shared` makes it visible to everyone in
your organization, who can start sessions in it and review its changes. After adoption, only an
organization owner changes the visibility, in the Visibility section of the project's setup page.
Making a shared project private drains other members' warm workspaces; their sessions keep running
until they end. Read [Organizations](/organizations/overview/).

## Store layout

Each project has a bare repository. Worktree files live as chains of captures in object storage:

```text
<store>/<project>/repo.git
bucket: captures/<worktree>/<epoch>/…
```

An install adopted before the capture store also has `<store>/<project>/worktrees/<worktree>/`
directories; the first launch or resume in each one registers its files as the worktree's first
capture. Read [How Mend works](/concepts/how-mend-works/#project-store).

The store copy is canonical for Mend. Your previous checkout remains separate. Use normal Git
commits, fetches, and pushes to exchange work.

New sessions base on the branch tips the store holds. Bring them up to date with origin:

```sh
mend refresh
```

With no argument it refreshes the project the current directory belongs to; `mend refresh <project>`
names one.

## Start the first session

After adoption:

```sh
mend codex
```

The CLI matches the current checkout to an adopted project by original path, remote URL, or project
name. Use `--project <name>` when you need to select one explicitly.

Read [Start a session](/getting-started/first-session/) for launch, detach, reattach, and resume
behavior.
