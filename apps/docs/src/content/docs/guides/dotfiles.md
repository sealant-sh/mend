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

The command shows the configured repository and the current synced snapshot. The repository line
names its branch, subdirectory, manager and whether `./install.sh` runs, for example
`(default branch · dots/ · manager auto · install.sh on)`. Snapshot output lists paths, sizes,
source hostname, and a short content digest.

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
- the [manager](#choose-a-manager) that applies the tree;
- whether Mend runs `./install.sh` when the selected tree contains it.

Or set it from the terminal:

```sh
mend dotfiles repo git@github.com:you/dots.git --subdirectory dots --manager copy
```

The command sets the whole repository: an option you leave out takes its default (`--ref` the
remote's default branch, `--subdirectory` the repository root, `--manager auto`, and `./install.sh`
on unless you pass `--no-bootstrap`). `mend dotfiles repo --clear` removes the repository.

At each launch, the server clones the repository as you, archives the selected tree, and sends the
archive to the workspace. [Which credentials the clone uses](#which-credentials-the-clone-uses) is
below.

Saving the repository runs that same clone and archive once. If it fails (the server cannot reach
the repository, the branch or subdirectory does not exist, or the tree is over the size limits),
Mend does not save the repository and shows the reason. The check is a launch's clone, so it counts
toward the account's launches starting at once (`MEND_BUDGET_ACCOUNT_LAUNCHES_IN_FLIGHT`); past that
budget the save is refused until a launch settles.

### Which credentials the clone uses

The clone uses your own [Git access](/guides/git-access/), never another account's:

- **An SSH URL** (`git@github.com:you/dots.git` or `ssh://…`) signs with your Git access: your Mend
  key, or your connected signer if your Git access is the bridge. Add your Mend public key to your
  Git account's SSH keys, or as a deploy key on the dotfiles repository. With the bridge, a signer
  must be connected when sessions launch (an attaching `mend` command, the dashboard, or
  `mend keys share`); while none is, sessions launch without the repository and say why.
- **An HTTPS URL** clones without a credential, so only a public repository clones that way. Mend
  holds no HTTPS token for your account: a connected GitHub account's token stays with the platform
  and is never returned to the server. For a private repository, save its SSH URL instead.

Mend refuses a URL that carries a token or password (`https://token@github.com/…`): it stores the
URL and shows it on your sessions. A login name over SSH (`git@…`, `ssh://git@…`) is fine.

These clones read none of the server's own Git or SSH setup: no credential helper, `.netrc`, SSH
agent, SSH config or key files.

The exception is a single-tenant install (`MEND_TENANCY=single`, the default): there, the operator's
own dotfiles clone with the server's Git and SSH setup, as a shell on that machine would. Every
other account on that install follows the rules above.

### Choose a manager

The manager decides how the repository's tree lands in the workspace home directory:

| Manager   | What it does                                                                          |
| --------- | ------------------------------------------------------------------------------------- |
| `auto`    | Picks one of the three below from the top level of the tree. The default.             |
| `copy`    | Copies the tree into the home directory as it is.                                     |
| `stow`    | Links each top-level directory into the home directory as a GNU stow package.         |
| `chezmoi` | Runs `chezmoi apply` with the tree as its source, so `dot_` names and templates work. |

`auto` uses chezmoi when the top level is a chezmoi source (`.chezmoi*`, `dot_*`, `private_*` or
`*.tmpl` entries). It uses stow only for a pure stow layout: package directories at the top level
and no dot entries beside them. Plain files such as `README.md` or a `Brewfile` do not count, and
neither do Git's and stow's own files (`.gitignore`, `.github/`, `.stow-local-ignore`). Any other
tree is copied, including a home mirror that holds `.config/` and `.zshenv` beside `bin/`.

Pick a manager explicitly when `auto` would choose differently from what you intend. A repository
whose top level mirrors your home directory wants `copy`. For stow packages kept beside other files,
point `--subdirectory` at the directory that holds only the packages.

Files from the synced snapshot always apply with `copy`, after the repository.

## Add files from the web app

The Dotfiles settings page can upload files into the synced snapshot. Uploaded files merge with the
existing snapshot. Files from the snapshot overwrite same-named files supplied by the repository.

Use the CLI for nested paths. Browser file selection normally supplies only the selected file name.

## Enable dotfiles for a project

Open the project's **Setup** page and turn **Dotfiles** on. The switch is per project because some
repositories need a controlled environment.

Dotfiles apply only to managed OS-family images. Mend skips them for custom images, where the base
image and setup commands own the home environment.

## Default shell profile

For people who bring no shell setup of their own, Mend writes a default zsh profile when a session
launches into a zsh workspace:

- `~/.zshrc`: 100,000 lines of shared history in `~/.local/state/zsh/history`, `autocd`, menu
  completion that ignores case, fzf key bindings and completion, the direnv hook, the
  `zsh-autosuggestions`, `zsh-syntax-highlighting` and `zsh-history-substring-search` plugins (up
  and down arrows search history for what you typed), and a starship prompt. It defines no aliases.
- `~/.config/starship.toml`: a one-line prompt with the directory, OS, Git branch and status, and
  the Node.js, Rust, Go and PHP versions.

Your dotfiles win. Mend writes each file only when nothing is at that path after your dotfiles have
been applied, and never overwrites one. A dotfiles `.zshrc` keeps Mend's `starship.toml` beside it
unless your dotfiles bring that file too.

The profile expects these packages, which the default workspace environment includes:

```text
fzf
starship
direnv
zsh-autosuggestions
zsh-syntax-highlighting
zsh-history-substring-search
```

Every block checks for its tool or plugin file first, so on an image without one of them that block
is skipped and the shell still starts. The plugins are looked up where the Arch, Fedora, Ubuntu and
Nix packages install them.

The profile applies only to managed OS-family images whose shell is zsh, not to `bash`, `fish` or
custom images. To turn it off for a project, open its **Setup** page and turn **Default shell
profile** off under **Dotfiles**. A workspace that is already running keeps the files it has.

## Git author and your `.gitconfig`

Mend writes your [Git author](/guides/git-access/#git-author) into each workspace as system Git
config before the agent starts. System config has the lowest precedence, so a `user` section in your
dotfiles' `.gitconfig`, or in a repository's own config, still decides who commits.

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
