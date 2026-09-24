---
title: Dotfiles
description: Apply your own shell and tool configuration to Mend session workspaces.
sidebar:
  order: 5
---

Dotfiles belong to a Mend user. They follow you across projects without reading the Mend server's
home directory. A project decides whether to apply the launching user's dotfiles to its sessions.

Mend can combine two sources:

- a Git repository cloned by the Mend server at each launch;
- a snapshot of selected home files captured from the machine where those files live.

The workspace receives file trees, not the repository URL or a Git credential.

## Inspect your dotfiles

```sh
mend dotfiles
```

The command shows the configured repository and the current synced snapshot. Snapshot output lists
paths, sizes, source hostname, and a short content digest.

## Sync files from this machine

Run the command without paths to scan for known configuration files:

```sh
mend dotfiles sync
```

This is a preview. It prints candidates but does not upload them.

Sync all discovered candidates:

```sh
mend dotfiles sync --all
```

Or choose exact paths relative to your home directory:

```sh
mend dotfiles sync .zshrc .gitconfig .config/ghostty/config
```

Mend refuses paths outside your home directory and reports unreadable or unsupported entries. A
successful sync replaces the previous snapshot and applies from the next session launch.

## Configure a repository

Open **Settings → Dotfiles** and provide a repository URL. Optional fields control:

- the branch or ref; an empty value uses the remote's default branch;
- a repository subdirectory whose contents should become the home tree;
- whether Mend runs `./install.sh` when the selected tree contains it.

At each launch, the server clones or refreshes the repository with its own host Git and SSH setup,
archives the selected tree, and sends the archive to the workspace.

Saving the repository runs that same clone and archive once. If it fails (the server cannot reach
the repository, the branch or subdirectory does not exist, or the tree is over the size limits),
Mend does not save the repository and shows the reason. The check is a launch's clone, so it counts
toward the account's launches starting at once (`MEND_BUDGET_ACCOUNT_LAUNCHES_IN_FLIGHT`); past that
budget the save is refused until a launch settles.

Automatic mode detects chezmoi and stow layouts. Other repositories are copied into the workspace
home directory.

## Add files from the web app

The Dotfiles settings page can upload files into the synced snapshot. Uploaded files merge with the
existing snapshot. Files from the snapshot overwrite same-named files supplied by the repository.

Use the CLI for nested paths. Browser file selection normally supplies only the selected file name.

## Enable dotfiles for a project

Open the project's **Setup** page and turn **Dotfiles** on. The switch is per project because some
repositories need a controlled environment.

Dotfiles apply only to managed OS-family images. Mend skips them for custom images, where the base
image and setup commands own the home environment.

## Launch timing

Dotfiles resolve at workspace creation. A running workspace does not change when you sync another
snapshot or update the repository. Start a new session, or resume into a fresh workspace, to use the
new tree.

If a source fails at launch, for example because the clone was stopped at its time limit, the
session still starts without that source. The other source still applies. The session page shows the
source that was not applied and the reason, for example
`dotfiles · repo not applied · the dotfiles repo … was stopped after 60s`.

Each session receives the dotfiles of its owner. A collaborator reading or controlling that session
does not replace them with another user's files.

## Keep secrets out

Do not sync private keys, provider tokens, `.env` files, or tool credentials as dotfiles. Use
[provider accounts](/guides/provider-accounts/) and
[project secrets](/guides/environment-variables/) for those values.
