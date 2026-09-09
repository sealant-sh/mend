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

| Command                                             | Purpose                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mend login [--url <server>]`                       | Sign in through the browser. The CLI opens `<server>/authorize`, waits for you to press Authorize, and saves a revocable device token with mode `0600` |
| `mend logout`                                       | Revoke this terminal's device token on the server and remove it from this machine                                                                      |
| `mend connect <provider> [--from-stdin] [--remove]` | Connect or remove `claude`, `codex`, or `github` for the signed-in user                                                                                |
| `mend accounts`                                     | List the signed-in user's connected provider accounts                                                                                                  |
| `mend doctor`                                       | Run a read-only setup checklist and print a repair command for unfinished items                                                                        |
| `mend pair [--url <base-url>]`                      | Create a single-use, ten-minute pairing code for another device; `--url` selects one of the server's configured origins                                |
| `mend version`                                      | Print this CLI's version and the server's, when it answers within two seconds                                                                          |

Read [Connect provider accounts](/guides/provider-accounts/) for credential sources and removal.

## Server commands

Server commands run on the machine that hosts Mend. They manage the local Docker Compose
installation created by `mend server setup`; they do not sign this CLI in or change Docker's global
context.

| Command                                                                           | Purpose                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mend server setup [options]`                                                     | Install or repair the local server: check the Docker context and Compose plugin, download one release's assets, claim the persistent volumes, pull and verify the pinned images, start both containers, then verify health |
| `mend server status`                                                              | Show the saved pin, active generation, and container state without changing anything; a running Mend must answer health with the exact pinned version                                                                      |
| `mend server start [--offline]`                                                   | Start the selected generation from preloaded images; never downloads assets or pulls release images                                                                                                                        |
| `mend server stop`                                                                | Stop Mend and Postgres without deleting volumes; workspace containers remain                                                                                                                                               |
| `mend server restart [--offline]`                                                 | Restart Mend on the same generation and pin; Postgres keeps running                                                                                                                                                        |
| `mend server logs [--tail <n>]`                                                   | Print a bounded tail of both containers' logs, 1 to 1000 lines per service, default 100; no follow mode                                                                                                                    |
| `mend server upgrade --version <target\|latest> [--assets-dir <dir>] [--offline]` | Upgrade to an explicit version after validating its assets and image label, stopping application writers, and saving a private database backup; downgrades are refused                                                     |

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
[self-hosting guide](https://github.com/sealant-sh/mend/blob/main/docs/SELF-HOSTING.md) for
exposure, offline assets, locks, and upgrade recovery.

## Project commands

| Command                                                                                       | Purpose                                                                                                      |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `mend adopt [git-url] [--name <name>] [--auth <mode>]`                                        | Clone a network Git repository into the store; with no URL, the current checkout's `origin`                  |
| `mend refresh [project]`                                                                      | Fetch origin's branches into the store so new sessions base on current tips                                  |
| `mend projects`                                                                               | List adopted projects and their live sessions                                                                |
| `mend env load [file] [--secret [A,B]] [--project <name>]`                                    | Load dotenv values into project configuration and secrets                                                    |
| `mend env show [--project <name>]`                                                            | List configuration, secret, and cluster-binding names; never secret values                                   |
| `mend env cluster add secret\|configmap <name>`, `remove <kind>/<name>`, `sa <name>\|--clear` | Bind Kubernetes Secrets, ConfigMaps, and a service account to a project's workspaces; Mend stores names only |

Git authentication modes for `mend adopt` are `mend-key`, `bridge`, and `ambient`. The default is
your Git access mode from `mend keys mode`, which is `mend-key` until you change it. Local paths,
`file://` URLs, option-like sources, and Git remote helpers are rejected.

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
| `--worktree <name>`                      | Join an existing worktree only — fails naming candidates when absent |
| `--ask`                                  | Restore the harness's permission prompts                             |
| `--fast`                                 | Request the Codex priority service tier                              |
| `--detach`, `-d`                         | Launch without attaching; reattach anywhere with `mend attach`       |
| `--foreground`                           | Stop the session when this CLI exits (the detach key still detaches) |
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
semantics — the session stops when the launching `mend` exits. `--detach` and `--foreground`
override both for one launch. Foreground stops are best-effort on signals: a `SIGKILL` or power loss
cannot stop anything — `mend sessions` shows what still runs and `mend stop` ends it. The switch
applies to interactive CLI launches (`mend codex|claude|opencode`); `mend run` tails the record
without attaching, and browser or phone clients never stop a session by disconnecting.

Inside a session workspace, the staged helper accepts `mend stop` too, so a workspace shell (or the
agent itself) can end its own session.

Codex uses model, effort, permission, and speed options. Claude uses model, effort, and permission
options. OpenCode currently uses only the prompt; the other harness flags are accepted but ignored.

## Session commands

| Command                                                     | Purpose                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| `mend` or `mend ui`                                         | Open the terminal dashboard of projects and worktrees          |
| `mend worktrees [--project <name>] [--json]`                | List worktrees and the sessions inside them                    |
| `mend sessions [--all] [--project <name>] [--json]`         | List active sessions, or include settled sessions with `--all` |
| `mend status`                                               | Alias for the active-session list                              |
| `mend attach <session-id-prefix>`                           | Reattach to a running agent PTY                                |
| `mend stop <session-id-prefix> \| --all [--project <name>]` | Stop the agent — the record and review remain                  |
| `mend shell [session-id-prefix]`                            | Open a shell in a live session workspace                       |
| `mend continue [session-id]`                                | Resume a session with its pending review follow-up             |
| `mend resume [session-id] [--with <harness>]`               | Restore provider state and resume a settled session            |
| `mend rejoin [session-id] [--harness <harness>]`            | Attach when live, otherwise resume                             |

When no session ID is given, commands narrow candidates by the current project and then use an
interactive picker when needed.

`mend sessions --json` is the stable automation output (`"version": 1`, flat sessions) and does not
change shape. `mend sessions --json=v2` and `mend worktrees --json` emit the worktree-grouped
envelope (`"version": 2`); against an older server every session appears as its own worktree with
`"id": null`, so the shape is stable either way. Human-readable rows may change as the interface
improves.

Deleting a session removes only the conversation record; the worktree — with its change and
checkpoints — remains. Removing a worktree is its own explicit act (dashboard `Shift+D`, or the
API): refused while any session is live, and refused while the worktree still holds any change
against its base unless forced.

## Dashboard keys

The dashboard groups sessions by worktree: a worktree with one session stays a single row, and a
shared worktree shows a header with its conversations underneath.

| Key             | On a session row                                      | On a worktree header                       |
| --------------- | ----------------------------------------------------- | ------------------------------------------ |
| `Enter`         | Attach, or resume when settled                        | Attach the newest live session, else start |
| `n`             | New worktree (name asked first)                       | Same                                       |
| `s`             | New session in this worktree                          | Same                                       |
| `x` / `Shift+K` | Stop the session (press twice)                        | Stop every live session (press twice)      |
| `Shift+D`       | Remove the worktree (press twice; refused while live) | Same                                       |
| `v`             | Review the worktree's change                          | Same                                       |
| `e`             | Rename the session label                              | —                                          |
| `o`             | Open in the browser                                   | —                                          |

## Terminal attachment

The CLI sends terminal input and resize events over one WebSocket and replays recorded output before
following live frames.

Press `Ctrl+]` to detach without stopping the process. Set:

```sh
export MEND_DETACH_KEY=none
```

when tmux, Zellij, or another outer tool owns detaching.

## Dotfiles commands

| Command                         | Purpose                                                 |
| ------------------------------- | ------------------------------------------------------- |
| `mend dotfiles`                 | Show the configured repository and synced file snapshot |
| `mend dotfiles sync`            | Preview known dotfile candidates on this machine        |
| `mend dotfiles sync --all`      | Replace the snapshot with all discovered candidates     |
| `mend dotfiles sync <paths...>` | Replace the snapshot with selected home-relative paths  |

Read [Dotfiles](/guides/dotfiles/) before syncing credentials or machine-specific files.

## Skills commands

| Command                                                     | Purpose                                                                                                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mend skills [--project [p]]`                               | List your skill library on the server, or a project's                                                                                               |
| `mend skills push [--project [p]] [--prune] [--dir <path>]` | Upload skill bundles from `~/.agents/skills`; sessions receive them at launch, and `--prune` removes server-side skills the directory no longer has |

## Git key commands

| Command                             | Purpose                                                             |
| ----------------------------------- | ------------------------------------------------------------------- |
| `mend keys init`                    | Generate the Mend machine's Ed25519 deploy key                      |
| `mend keys show`                    | Print the public key and fingerprint                                |
| `mend keys mode [mend-key\|bridge]` | Show or set your default Git access mode for new projects           |
| `mend keys share`                   | Relay this machine's SSH agent to the Mend server until interrupted |

The key bridge requires a reachable local SSH agent. Signing happens on the machine holding the key.

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

`mend service run` accepts `--name`, `--port`, `--udp`, `--http`, `--https`, and `--no-connect`.
Read [Development services](/guides/services/) for network and authentication boundaries.

### `mend` inside the workspace

Every session workspace has a `mend` command of its own on the PATH. It is not the CLI above and not
part of the workspace image: the server stages a small helper into the session's run directory,
mounted read-only at `/run/mend` and linked to `/usr/local/bin/mend`, so it is always version-locked
to the server. It talks only to its own session, over the session socket (or the authenticated
session endpoint on Kubernetes), and it speaks Services only:

| Command                                                               | Purpose                              |
| --------------------------------------------------------------------- | ------------------------------------ |
| `mend service` or `mend service list`                                 | List this session's live Services    |
| `mend service run --port <port> [--name <n>] [--udp] -- <command...>` | Start and supervise a Service        |
| `mend service run <name>` or `mend service <name>`                    | Start a recipe from `mend.toml`      |
| `mend service add <port> [--name <n>] [--udp]`                        | Adopt an existing workspace listener |
| `mend service stop <name-or-id>`                                      | Stop a Service                       |
| `mend service restart <name-or-id>`                                   | Start another attempt                |

The helper has no `--http`/`--https`, no `init`, no `logs`, and no `connect` — browser schemes,
history, and reaching the endpoint stay on your side. Its job is declaration: an agent that starts a
dev server can register it as a real Service instead of leaving an unobserved listener.

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
