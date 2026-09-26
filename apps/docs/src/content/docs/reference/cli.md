---
title: CLI reference
description: Commands, flags, configuration, and terminal behavior for the Mend CLI.
sidebar:
  order: 1
---

The `mend` CLI talks to the Mend server. Run `mend help` for the help text installed with your
version. One-shot commands require Node 22 or newer. The terminal dashboard requires Node 26 and
`node:ffi`; every other command still works when the dashboard cannot start.

## Setup commands

| Command                                                                           | Purpose                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mend login [--url <server>]`                                                     | Sign in through the browser. The CLI opens `<server>/authorize`, waits for you to press Authorize, and saves a revocable device token with mode `0600`                                                                                                                        |
| `mend logout`                                                                     | Revoke this terminal's device token on the server and remove it from this machine                                                                                                                                                                                             |
| `mend uninstall [--all \| --server \| --home] [--yes]`                            | Remove the local server (containers, volumes, image, private configuration), this machine's Mend files (sign-in, workspace SSH key, managed `~/.ssh/config` block), or both; asks for the scope and prints the plan first, and needs the word `delete` before the server goes |
| `mend connect <claude\|codex\|github> [--use-my-login] [--from-stdin] [--remove]` | Connect or remove a provider for the signed-in user; the credential is stored under your own user and shared with no one                                                                                                                                                      |
| `mend accounts`                                                                   | List the signed-in user's connected provider accounts                                                                                                                                                                                                                         |
| `mend doctor`                                                                     | Run a read-only setup checklist and print a repair command for unfinished items                                                                                                                                                                                               |
| `mend doctor --bundle [--out <path>] [--tail <n>]`                                | Write one redacted diagnostic archive for a bug report; default path `~/.config/mend/bundles/mend-bundle-<time>.tgz`, `--tail` 1 to 2000 lines per log, default 500                                                                                                           |
| `mend pair [--url <base-url>]`                                                    | Create a single-use, ten-minute pairing code for another device; `--url` selects one of the server's configured origins                                                                                                                                                       |
| `mend version`                                                                    | Print this CLI's version and the server's, when it answers within two seconds                                                                                                                                                                                                 |

`mend connect codex` reads the file the Codex CLI wrote when you logged in, and
`mend connect github` asks `gh` for its token. `mend connect claude` opens a browser login for a
Claude login of Mend's own, kept in a directory Mend holds, so your own Claude login stays as it is.
Claude rotates its refresh token, and two copies of one login sign each other out; `--use-my-login`
sends the login this machine already uses instead, and both sides then share one grant. Run
`mend connect claude` again when Mend says the grant expired. Read
[Connect provider accounts](/guides/provider-accounts/) for credential sources and removal.

`mend doctor --bundle` collects the CLI and its environment, the doctor lines, the server's health,
the local server's compose file and the names of its `.env` keys (never their values), Docker facts,
container logs, every session with its processes, exit codes, argv and recorded terminal output, the
connected accounts, and the versions of `claude`, `codex`, `gh`, `git` and `docker`. A part that
fails leaves a `<name>.error.txt` in the archive. One redactor runs over every file, and the archive
is written with mode `0600`. It still contains logs and configuration; read it before you share it.
See [Troubleshooting](/operate/troubleshooting/).

## Server commands

Server commands run on the machine that hosts Mend. They manage the local Docker Compose
installation created by `mend server setup`; they do not sign this CLI in or change Docker's global
context.

| Command                                                                           | Purpose                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mend server setup [options]`                                                     | Install or repair the local server: check the Docker context and Compose plugin, download one release's assets, claim the persistent volumes, pull and verify the pinned images, start the Mend, Postgres and Garage containers, then verify health |
| `mend server status`                                                              | Show the saved pin, active generation, and container state without changing anything; a running Mend must answer health with the exact pinned version                                                                                               |
| `mend server start [--offline]`                                                   | Start the selected generation from preloaded images; never downloads assets or pulls release images                                                                                                                                                 |
| `mend server stop`                                                                | Stop Mend, Postgres and Garage without deleting volumes; workspace containers remain                                                                                                                                                                |
| `mend server restart [--offline]`                                                 | Restart Mend on the same generation and pin; Postgres and Garage keep running                                                                                                                                                                       |
| `mend server logs [--tail <n>]`                                                   | Print a bounded tail of each container's logs, 1 to 1000 lines per service, default 100; no follow mode                                                                                                                                             |
| `mend server upgrade --version <target\|latest> [--assets-dir <dir>] [--offline]` | Upgrade to an explicit version after validating its assets and image label, stopping application writers, and saving a private database backup; downgrades are refused                                                                              |

Setup options:

| Option                   | Meaning                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `--context <name>`       | Local Unix-socket Docker context to persist; the global context is unchanged                                          |
| `--version <v>`          | Exact Mend server version, or `latest`; a fresh setup pins the CLI's own version, and a rerun keeps the existing pin  |
| `--bind <ip>`            | Published listen address for web and SSH; default `127.0.0.1`                                                         |
| `--url <origin>`         | Advertised browser URL; required with a non-loopback bind                                                             |
| `--origin <origin>`      | Additional exact browser origin; repeat for more than one                                                             |
| `--port <n>`             | External web port; default `3105`; must differ from the SSH port                                                      |
| `--ssh-port <n>`         | External workspace SSH port; default `2222`                                                                           |
| `--assets-dir <dir>`     | Copy `compose.v2.yaml` and `postgres-init.sh` from a local release directory; a fresh setup then requires `--version` |
| `--offline`              | Use retained or supplied assets and preloaded images only; no GitHub requests or release-image pulls                  |
| `--docker-socket <path>` | Daemon-side socket mount override for diagnostics; retained on reruns                                                 |

Setup holds an exclusive lock through startup and health checks, keeps private configuration in
immutable generations, and never deletes Docker volumes. A changed `--version` on a rerun is
refused; use `mend server upgrade`. Read [Install Mend](/getting-started/install/) and the
[self-hosting guide](https://github.com/sealant-sh/mend/blob/main/docs/SELF-HOSTING.md) for offline
assets, locks, and upgrade recovery, and [Exposure and budgets](/operate/exposure/) for how the
server is reached. Setup does not set `MEND_EXPOSURE`; a server it installs runs as `private`.

## Project commands

| Command                                                                                       | Purpose                                                                                                      |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `mend adopt [git-url] [--name <name>] [--auth <mode>] [--private\|--shared]`                  | Clone a network Git repository into the store; with no URL, the current checkout's `origin`                  |
| `mend refresh [project]`                                                                      | Fetch origin's branches into the store so new sessions base on current tips                                  |
| `mend projects`                                                                               | List adopted projects and their live sessions                                                                |
| `mend env load [file] [--secret [A,B]] [--project <name>]`                                    | Load dotenv values into project configuration and secrets                                                    |
| `mend env show [--project <name>]`                                                            | List configuration, secret, and cluster-binding names; never secret values                                   |
| `mend env cluster add secret\|configmap <name>`, `remove <kind>/<name>`, `sa <name>\|--clear` | Bind Kubernetes Secrets, ConfigMaps, and a service account to a project's workspaces; Mend stores names only |

Git authentication modes for `mend adopt` are `mend-key`, `bridge`, and `ambient`. The default is
your Git access mode from `mend keys mode`, which is `mend-key` until you change it. Local paths,
`file://` URLs, option-like sources, and Git remote helpers are rejected.

A project is `--private` by default: only you see it. `--shared` makes it visible to everyone in
your organization, who can then start sessions in it. See [Organizations](/organizations/overview/).

## Start agents and commands

```text
mend codex ["prompt"] [options]
mend claude ["prompt"] [options]
mend opencode ["prompt"] [options]
mend run -- <command...>
```

Agent options:

| Option                                   | Meaning                                                              |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `--model <id>`                           | Pass a model selection to a supported harness                        |
| `--effort low\|medium\|high\|xhigh\|max` | Pass the reasoning effort                                            |
| `--base <ref>`                           | Create the worktree from another Git base                            |
| `--name <worktree>`                      | Name the worktree; an existing name joins it as a new session        |
| `--worktree <name>`                      | Join an existing worktree only; fails naming candidates when absent  |
| `--ask`                                  | Restore the harness's permission prompts                             |
| `--fast`                                 | Request the Codex priority service tier                              |
| `--detach`, `-d`                         | Launch without attaching; reattach anywhere with `mend attach`       |
| `--foreground`                           | Stop the session when this CLI exits (the detach key still detaches) |
| `--no-tunnel`                            | Do not tunnel the session's browser Services to this machine         |
| `--land`, `--no-land`                    | Land, or do not land, when a turn completes, for this session only   |
| `--project <name>`                       | Select an adopted project instead of matching the current directory  |

A quoted prompt becomes the first message and supplies the initial session name. Interactive
launches ask for the worktree's name first (enter accepts an automatic one); `--name` answers it up
front. The CLI creates or joins the worktree, says so when a name joins an existing one, waits for
the workspace and process, then attaches the current terminal. Requesting a `--base` that differs
from an existing worktree's base is refused rather than silently re-basing it.

### Background sessions

Sessions run in the background: closing the terminal, losing the network, or the CLI dying leaves
the session running, and stops are explicit. The `Sessions` switch in Settings (overridable per
project, `inherit · on · off`) turns this off for interactive launches, giving them foreground
semantics: the session stops when the launching `mend` exits. `--detach` and `--foreground` override
both for one launch. Foreground stops are best-effort on signals: a `SIGKILL` or power loss cannot
stop anything; `mend sessions` shows what still runs and `mend stop` ends it. The switch applies to
interactive CLI launches (`mend codex|claude|opencode`); `mend run` tails the record without
attaching, and browser or phone clients never stop a session by disconnecting.

Inside a session workspace, the staged helper accepts `mend stop` too, so a workspace shell (or the
agent itself) can end its own session.

`--land` and `--no-land` override the project's "Land when a turn completes" setting for one session
(see [Landing commands](#landing-commands)); a project set to off wins over `--land`. Mend lands
after turns it runs itself, so an agent attached to a terminal lands on its own only once the
session is picked up on the phone. From the terminal, land it with `mend land`.

Codex uses model, effort, permission, and speed options. Claude uses model, effort, and permission
options. OpenCode currently uses only the prompt; the other harness flags are accepted but ignored.

## Session commands

| Command                                                        | Purpose                                                                                |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `mend` or `mend ui [--no-tunnel]`                              | Open the terminal dashboard of projects, worktrees and sessions                        |
| `mend snake`                                                   | Open the dashboard with a game of snake over it; `Esc` or `q` closes the game          |
| `mend worktrees [--project <name>] [--json]`                   | List worktrees and the sessions inside them                                            |
| `mend sessions [--all] [--project <name>] [--json\|--json=v2]` | List live sessions, or include settled sessions with `--all`                           |
| `mend status`                                                  | Alias for `mend sessions`                                                              |
| `mend attach [session-id-prefix] [--no-tunnel]`                | Reattach to a running session; a session picked up on the phone moves to this terminal |
| `mend stop [session-id-prefix]`                                | Stop the agent; the worktree, record and review remain                                 |
| `mend stop --all [--project <name>]`                           | Stop every live session, or every live session in one project                          |
| `mend stop --services [session-id-prefix]`                     | Stop the session's Services instead of its agent                                       |
| `mend shell [session-id-prefix]`                               | Open a shell in a live session workspace                                               |
| `mend continue [session-id]`                                   | Resume a session with its pending review follow-up                                     |
| `mend resume [session-id] [--with <harness>]`                  | Restore provider state and resume a settled session                                    |
| `mend rejoin [session-id] [--harness <harness>] [--no-tunnel]` | Attach when live, otherwise resume                                                     |

With no session ID, `attach`, `stop` and `shell` take the one live session; with several, a picker
opens. A prefix of the ID is enough. Other commands narrow candidates by the current project and
then use a picker when needed.

Services keep running after `mend stop`, and a running Service keeps the workspace up. The stop then
says so, for example `agent stopped · 3 services keep the workspace up`. `mend stop --services`
stops them; once nothing is live, the workspace closes.

`mend sessions --json` is the stable automation output (`"version": 1`, flat sessions) and does not
change shape. `mend sessions --json=v2` and `mend worktrees --json` emit the worktree-grouped
envelope (`"version": 2`); against an older server every session appears as its own worktree with
`"id": null`, so the shape is stable either way. Human-readable rows may change as the interface
improves.

Deleting a session removes only the conversation record; the worktree, with its change and
checkpoints, remains. Removing a worktree is its own explicit act (dashboard `Shift+D`, or the API):
refused while any session is live, and refused while the worktree holds work that is not on origin
(a change never landed, or one changed since its last landing) unless forced. The refusal names the
files and line counts that are not on origin.

## Landing commands

```text
mend land <session> [--branch <name>] [--no-pr] [--title <text>] [--project <name>]
mend land <session> --check [--project <name>]
mend pull <session> [--force] [--project <name>]
```

`<session>` is a prefix of the session ID or the worktree's name; settled sessions count.

`mend land` publishes a session's change. Only the change's owner lands it: the owner of the
worktree's first session. Mend takes a checkpoint, commits what the agent left uncommitted on top of
the agent's own commits and the last landing (never squashing or rewriting them, and never moving
the session's branch), and pushes that to origin with the project's git access, as `mend/<name>`
unless `--branch` names another. The project's default branch and the pull request's base are
refused, and a landing with nothing new since the last one pushes nothing and says so. The push only
fast-forwards: when origin's branch has commits Mend has not seen, or origin refuses, nothing is
pushed and the command prints the remote's own words. When origin is on GitHub, Mend then opens a
pull request into the session's base branch or updates the one it opened before, through your
connected GitHub account; `--no-pr` skips it. The command prints the landing and what Mend observed,
and exits 1 when the push was refused or a step failed:

```text
✓ pushed · mend/fix-login · 3f2a1c0 · pull request #412 · opened
  checkpoint 9e8d7c6
  commit 1a2b3c4 · Mend's, for the work left uncommitted
  pull request https://github.com/acme/api/pull/412
  observed
    pushed · mend/fix-login · 3f2a1c0 · observed
    pull request #412 · open · observed 0 s ago
```

A pull request someone opened outside Mend, including one the agent opened with `gh`, is found and
recorded as the change's own. Mend looks after the agent pushes a branch and when its turn ends, and
`mend land --check` looks now without pushing anything. It asks GitHub, as you, about the worktree's
branch, every branch the agent pushed, and the agent's head commit. A later landing pushes that pull
request's branch and updates it. A pull request from a fork is shown and never updated: Mend pushes
to origin only, and opens no second pull request beside it. Read
[Land a change](/guides/land-a-change/).

`mend pull` fetches a change into the local clone you run it in, as a branch of the same name. Mend
commits the latest checkpoint the way `mend land` does, without pushing, and sends the commits from
the session's base as a git bundle, so it works before landing and without origin. Only the change's
owner gets a checkpoint taken first; anyone else gets the latest one, and pulling moves nothing on
the server. One of the clone's remotes must be the project's origin (ssh and https spellings match;
`--force` skips the check), and the clone needs the session's base commit. The working tree, the
index and the current branch are not touched, and an existing local branch only fast-forwards. A
bundle over the server's `MEND_BUDGET_BUNDLE_BYTES` limit is refused with its size.

## Dashboard keys

The session pane takes three quarters of the screen: a read-only detail of the selected session with
the conversation record it has written so far. The remaining quarter is a sidebar of three stacked
sections, projects, then worktrees, then sessions. The section you are in stands open, and the other
two fold to the line that says what is selected. Moving the selection only navigates; nothing takes
the terminal until you press a verb. The footer names the keys that apply where you are.

| Key                                     | Action                                                                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `↑` `↓`, `j` `k`, `PgUp` `PgDn`         | Move inside the open section, or scroll the session pane                                                                                                                            |
| `Enter`, `→`, `l`, `Tab`                | Move right: projects, worktrees, sessions, then the session pane                                                                                                                    |
| `←`, `h`, `-`, `Backspace`, `Shift+Tab` | Move left                                                                                                                                                                           |
| `a`                                     | Attach a live session                                                                                                                                                               |
| `r`                                     | Resume a settled session                                                                                                                                                            |
| `n`                                     | Start another session in the selected worktree; on the projects section, start a new worktree                                                                                       |
| `w`                                     | Start a new worktree                                                                                                                                                                |
| `e`                                     | Rename the session                                                                                                                                                                  |
| `v`                                     | Review the change                                                                                                                                                                   |
| `o`                                     | Open the session in the browser                                                                                                                                                     |
| `Shift+K` or `x`                        | Stop the session (press twice). On the worktrees section, stop every live session in it. On a session whose agent stopped while Services keep the workspace up, stop those Services |
| `Shift+D`                               | Remove (press twice). On the worktrees section, remove the worktree, refused while a session is live; elsewhere, remove the session's record and keep the worktree                  |
| `Shift+R`                               | Refresh                                                                                                                                                                             |
| `q`                                     | Quit                                                                                                                                                                                |

A terminal too narrow for both sides gives the whole width to the side you are on, and one too short
for three sections shows the open section alone. On a server that is not this machine, the selected
session's live Services declared `--http` or `--https` are tunneled to this machine's loopback while
it stays selected, unless you started the dashboard with `--no-tunnel`. See
[Terminal dashboard and attach](/clients/terminal/).

## Terminal attachment

The CLI sends terminal input and resize events over one WebSocket and replays recorded output before
following live frames.

Press `Ctrl+]` to detach without stopping the process. Set:

```sh
export MEND_DETACH_KEY=none
```

when tmux, Zellij, or another outer tool owns detaching.

`Ctrl+V` with an image on this machine's clipboard sends the image to the session and pastes its
path; Codex and Claude read it. It needs `wl-paste` on Wayland or `xclip` on X11, and nothing extra
on macOS.

## Dotfiles commands

| Command                                                                                      | Purpose                                                                                                                   |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `mend dotfiles`                                                                              | Show the configured repository, with its manager, and the synced file snapshot                                            |
| `mend dotfiles repo <url> [--ref <r>] [--subdirectory <d>] [--manager <m>] [--no-bootstrap]` | Set the repository the server clones at launch; `<m>` is `auto`, `copy`, `stow` or `chezmoi`; saving tries the clone once |
| `mend dotfiles repo --clear`                                                                 | Remove the repository                                                                                                     |
| `mend dotfiles sync`                                                                         | Preview known dotfile candidates on this machine                                                                          |
| `mend dotfiles sync --all`                                                                   | Replace the snapshot with all discovered candidates                                                                       |
| `mend dotfiles sync <paths...>`                                                              | Replace the snapshot with selected home-relative paths                                                                    |

Read [Dotfiles](/guides/dotfiles/) before syncing credentials or machine-specific files.

## Skills commands

| Command                                                     | Purpose                                                                                                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mend skills [--project [p]]`                               | List your skill library on the server, or a project's                                                                                               |
| `mend skills push [--project [p]] [--prune] [--dir <path>]` | Upload skill bundles from `~/.agents/skills`; sessions receive them at launch, and `--prune` removes server-side skills the directory no longer has |

Your library applies to every session you start; a project's library applies to sessions in that
project. See [Skills](/guides/skills/).

## Git commands

| Command                             | Purpose                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `mend keys init`                    | Create your Mend key (Ed25519), held on the server; one key per user         |
| `mend keys show`                    | Print your Mend public key                                                   |
| `mend keys mode [mend-key\|bridge]` | Show or set your Git access mode for new projects; `mend-key` is the default |
| `mend keys share`                   | Relay this machine's SSH agent to the Mend server until interrupted          |
| `mend git-author [<name> <email>]`  | Show or set the name and email your workspaces commit as                     |
| `mend git-author --clear`           | Go back to your account's name and email                                     |

Add your Mend public key to your Git account's SSH keys and every repository you can reach works,
from detached sessions and the phone too. For one repository only, add it as that repository's
deploy key instead. In `bridge` mode every attaching `mend` command and the dashboard relay this
machine's SSH agent while they run, so `mend keys share` is for a machine that runs nothing else.
The server takes one signer at a time; a newer share replaces the older one. The bridge requires a
reachable local SSH agent, and signing happens on the machine holding the key. See
[Git access](/guides/git-access/).

The Git author is set as system Git config in each workspace before the agent starts, so a `user`
section in your dotfiles' `.gitconfig` or in a repository's own config still decides. Until you set
one, it is the name and email you registered with. Sessions launched after a change commit as the
new author.

## Workspace SSH commands

| Command                                             | Purpose                                                                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mend ssh [status]`                                 | Report the gateway, this client's registered key, and the managed `~/.ssh/config` block; it does not test a connection or verify the host key                                        |
| `mend ssh setup [--key <path>] [--host <hostname>]` | Register this client's public key and write a server-specific Host block before wildcard defaults; the hostname defaults to the configured Mend URL and the server supplies the port |

The VS Code extension uses the same configuration. Read
[workspace SSH](https://github.com/sealant-sh/mend/blob/main/docs/WORKSPACE-SSH.md) for identity
selection and host-key verification.

## Service commands

| Command                                                                       | Purpose                                                                     |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `mend service init [--yes]`                                                   | Scaffold `mend.toml` from package and Compose files                         |
| `mend service run [session] --port <port> [options] -- <command...>`          | Start and supervise a Service command; tunnels the port here when remote    |
| `mend service run [session] <name>`                                           | Start a recipe from `mend.toml`                                             |
| `mend service <name>`                                                         | Shorthand for a named recipe                                                |
| `mend service add [session] <port> [--name <name>] [--udp] [--http\|--https]` | Forward an existing workspace listener without supervising it               |
| `mend service connect [name...] [--port <port>]`                              | Bring live Services to this machine's loopback over an authenticated tunnel |
| `mend service list`                                                           | List live Services and observed endpoints                                   |
| `mend service logs <name-or-id> [--from <sequence>]`                          | Replay and follow recorded Service output                                   |
| `mend service restart <name-or-id>`                                           | Start another attempt for a supervised Service                              |
| `mend service stop <name-or-id>`                                              | Stop the process and close its host port                                    |

`mend service run` accepts `--name`, `--port`, `--udp`, `--http`, `--https`, and `--no-connect`. On
a server that is not this machine, `mend attach`, `mend codex|claude|opencode`, `mend rejoin`, and
the dashboard tunnel the session's live Services declared `--http` or `--https` to this machine's
loopback while attached, on the Service's own port when it is free. One line each says where it
opens (`web → http://localhost:5173`); a Service that stops closes its tunnel, and detaching closes
them all. `--no-tunnel` opts out.

Read [Development services](/guides/services/) for network and authentication boundaries.

### `mend` inside the workspace

Every session workspace has a `mend` command of its own on the PATH. It is not the CLI above and not
part of the workspace image: the server stages a small helper into the session's run directory,
mounted read-only at `/run/mend` and linked to `/usr/local/bin/mend`, so it is always version-locked
to the server. It talks only to its own session, over the session socket (or the authenticated
session endpoint), and it speaks Services plus `mend stop`:

| Command                                                                                 | Purpose                                         |
| --------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `mend service` or `mend service list`                                                   | List this session's live Services               |
| `mend service run --port <port> [--name <n>] [--udp] [--http\|--https] -- <command...>` | Start and supervise a Service                   |
| `mend service run <name>` or `mend service <name>`                                      | Start a recipe from `mend.toml`                 |
| `mend service add <port> [--name <n>] [--udp] [--http\|--https]`                        | Adopt an existing workspace listener            |
| `mend service stop <name-or-id>`                                                        | Stop a Service                                  |
| `mend service restart <name-or-id>`                                                     | Start another attempt                           |
| `mend stop`                                                                             | Stop this session; the record and review remain |

The helper has no `init`, no `logs`, and no `connect`: history and reaching the endpoint stay on
your side. Its job is declaration: an agent that starts a dev server can register it as a real
Service instead of leaving an unobserved listener, and `--http`/`--https` says it is something to
open in a browser (refused with `--udp`).

## Organization commands

| Command                                                               | Purpose                                                                                            |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `mend members`                                                        | Print the organization's name and one row per member: name, email, role and the day they joined    |
| `mend invite [--role member\|owner] [--email <address>] [--days <n>]` | Owners only. Print a single-use invitation link; default role `member`, default 7 days, at most 30 |
| `mend folder list`                                                    | List the organization's folders                                                                    |
| `mend folder create <name>`                                           | Owners only. Create a folder; names use lowercase letters, digits, dots, underscores and dashes    |
| `mend folder push <name> <dir> [--replace]`                           | Owners only. Upload a local directory into a folder; `--replace` empties the folder first          |
| `mend folder rm <name>`                                               | Owners only. Remove a folder; refused while a project still selects it                             |
| `mend session share <session> on\|off`                                | Turn shared control on or off for a session                                                        |

Mend sends no email: you share the invitation link yourself. With `--email`, only an account with
that address can accept it. Owners change roles and remove members in Settings on the web.

A project selects which folders its sessions receive, at `/workspace/home/<name>`, read-only unless
chosen otherwise, from its next session. `mend folder push` skips `.git` and `node_modules`
directories, symlinks, and files over 1 MiB, and counts what it skipped. See
[Folders](/organizations/folders/).

Only the session's owner turns shared control on; the owner or an organization owner turns it off.
While it is on, anyone who can see the project sends turns, answers approvals, interrupts and types
in the terminal, using the owner's provider logins and Git access. Every act is recorded with who
did it. See [Organizations](/organizations/overview/).

## Operator commands

These commands need the operator role, which the instance's first account holds. The operator
administers the instance and reads no organization content.

| Command                                                    | Purpose                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `mend operator exposure`                                   | Print `MEND_EXPOSURE` as declared and each item of the public exposure gate                 |
| `mend operator gate`                                       | Print each item of the multi mode gate, what this instance shows, and what would satisfy it |
| `mend operator org list`                                   | List organizations with their member and owner counts                                       |
| `mend operator org create <name>`                          | Create an organization; only with `MEND_TENANCY=multi`                                      |
| `mend operator org rename <org> <name>`                    | Rename an organization                                                                      |
| `mend operator org invite-owner <org> [--email <address>]` | Print a single-use link that makes whoever opens it an owner of the organization            |
| `mend operator grant-owner <org> <email>`                  | Make an existing member an owner, for an organization whose owners are gone or locked out   |
| `mend operator reset-link <email>`                         | Print a single-use password reset link, valid for a day                                     |

`mend operator exposure` marks each gate item `observed` (the server read it), `carried` (this build
contains it and the server cannot see it in effect), `declared` (you stated it and the server cannot
check it) or `open`. `MEND_EXPOSURE=public` refuses to start while an item the server can observe is
open. The report is what was observed; it does not say an instance is fit to expose. See
[Exposure and budgets](/operate/exposure/).

`MEND_TENANCY=multi` refuses to start while any item of the multi mode gate is open. Organization
changes the operator makes are recorded in that organization's audit log. Setting a password with a
reset link signs the account out everywhere; owners reset their members' passwords from Settings.

## Shell completion

```sh
mend completions zsh
mend completions bash
```

The generated hook completes command names and live session IDs. Add its output to the matching
shell configuration. Fish completion is not currently generated.

## CLI configuration

The CLI reads:

| Input                            | Default                                     |
| -------------------------------- | ------------------------------------------- |
| `MEND_URL`                       | `http://localhost:3105`                     |
| `MEND_TOKEN`                     | Saved token from the configuration file     |
| `MEND_DETACH_KEY`                | `Ctrl+]`                                    |
| `$XDG_CONFIG_HOME/mend/cli.json` | `~/.config/mend/cli.json` when XDG is unset |

The configuration file contains:

```json
{
  "url": "http://localhost:3105",
  "token": "<redacted>"
}
```

A legacy `~/.mend` directory remains authoritative when it is the only Mend configuration directory
on the machine.

## Exit behavior

One-shot commands print a readable server error and exit nonzero when a request fails. Interactive
commands return terminal control when the process ends or the user detaches. `mend doctor` does not
change server or machine state.

`mend help <command>` prints one command's page and `mend man <command>` opens the same page in
`man`; the npm package also installs `mend(1)` and `mend-<command>(1)` for a global install.
