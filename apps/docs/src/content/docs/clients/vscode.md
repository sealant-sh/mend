---
title: VS Code extension
description:
  Open Mend sessions in VS Code over workspace SSH, start sessions, and take over a running agent in
  the editor.
sidebar:
  order: 4
---

The Mend extension for VS Code (`apps/vscode`) lists your projects and sessions and opens a session
inside its workspace over SSH. The editor's files are the session's worktree, and its integrated
terminal runs in the workspace, with the workspace image, environment and harness home. A `claude`,
`codex` or `pi` you run in that terminal is observed by Mend: the session shows running, the
workspace stays up, and the conversation is recorded and can be resumed from any device. What
observation covers and what it does not is under
[Agents you run yourself](#agents-you-run-yourself).

In a [per-person workspace](/operate/per-person-workspaces/), the 0.36 default, the Remote-SSH login
is the workspace's launcher, as their own Linux user, on their home and logins. Where the server's
Sealant cannot bind the person (an older Core), it runs as root instead and the session line says
`Remote-SSH: root, Core can't bind your person`; an agent started in that terminal then does not use
your home and logins. Start agents from Mend (**+** → an agent) or in **Mend: Open terminal** there.

## Install

Search for **Mend by Sealant** (publisher `sealant-sh`) in the Extensions view, or run:

```sh
code --install-extension sealant-sh.mend
```

It is on the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=sealant-sh.mend) and
on [Open VSX](https://open-vsx.org/extension/sealant-sh/mend), which VSCodium and other VS Code
builds install from. Each version's `.vsix` is also attached to its `vscode-v<version>` release on
[GitHub](https://github.com/sealant-sh/Mend/releases); install one with
`code --install-extension mend-<version>.vsix`. The extension's version follows the Mend release it
needs: 0.36.x works with a Mend 0.36 server, and the patch number is the extension's own (0.36.1
carries the sign-in fixes below). To run an unreleased change, build it
[from source](#install-from-source).

## Requirements

- VS Code 1.100 or newer.
- Microsoft's Remote - SSH extension (`ms-vscode-remote.remote-ssh`). Without it, opening a session
  offers **Install Remote SSH** or **Copy code command**, which copies the `code --remote …` command
  that opens the same folder.
- A Mend server, version 0.36 or newer, with a workspace SSH gateway. When the server reports none,
  the extension says `This Mend deployment exposes no workspace SSH gateway.` and opens nothing.

The extension never falls back to opening the worktree's path on the Mend host. A terminal there
would run outside the workspace, where Mend does not observe it. **Mend: Copy worktree path** copies
that server-side path for your own use.

## The Mend view

The Mend icon in the Activity Bar opens **Projects and sessions**. It groups sessions waiting for
you under **Needs you**, then lists projects with their sessions and each session's status. Clicking
a session opens it. The status bar shows the project the open folder belongs to and how many
sessions are waiting. When the open folder belongs to an adopted project, the view shows that
project only; **Mend: Toggle current project scope** switches between it and every project.

With no project adopted, the view offers **Adopt a project…**, which asks for a Git clone URL and a
project name.

## Start a session

Click **+** in the view, or run **Mend: New Session…**, and pick one of:

- **Workbench**: a fresh worktree whose workspace is held open by a shell. VS Code opens in it, and
  you run `claude` or `codex` yourself in the terminal. Mend observes and records it, within the
  limits under [Agents you run yourself](#agents-you-run-yourself).
- **Claude agent** or **Codex agent**: Mend starts the harness on a prompt you type, and the
  workspace opens in VS Code beside it. An empty prompt starts the harness without one.
- **Agent with options…**: choose the harness (Claude, Codex, opencode or pi), model, thinking
  level, permissions (skip permission prompts, or ask before acting) and base branch. The model list
  is the server's, the same one every other client offers, with the server's default listed first.
  For opencode the list leads with `opencode's own choice`, which sends no model, so its config
  decides.

**Mend: New session in this worktree…** on a session starts a second session in the same worktree:
the same files and branch, with a new conversation. Each session keeps its own harness state, so the
new session does not see the first session's conversation. To continue that conversation, take the
session over instead.

**Mend: New worktree without an agent…** asks for a name and a base, creates the worktree, and opens
it.

## Open a session

Opening a live session opens its workspace. Opening a settled session asks whether to resume it as a
workbench shell. The shell starts a fresh workspace over the same worktree and keeps it up while the
editor is attached. No agent is launched.

In a [per-person workspace](/operate/per-person-workspaces/) only the workspace's launcher can open
it over Remote-SSH: the person whose session started the workspace. A session started in a worktree
where someone else's session already runs joins their workspace, so it is theirs to open, your own
session included. Opening one says so first, and offers the session's terminal when the server would
let you in. The Remote-SSH login runs as the launcher's own Linux user, on their home and logins, so
an agent they start in its terminal runs as them. Where the server's Sealant cannot bind the person
(an older Core), it runs as root instead, and the session line says
`Remote-SSH: root, Core can't bind your person`; an agent started there then does not use the
person's home and logins.

### Workspace SSH setup

The first open asks **Set up workspace SSH?**. Setup registers this machine's SSH public key with
Mend and adds one server-specific `Host` block at the start of `~/.ssh/config`, before any wildcard
entries. It keeps hand-written configuration and blocks for other Mend servers. On later runs it
reuses the key it chose. On first setup it can use a key from your SSH agent or create a dedicated
key under `~/.config/mend/ssh`. It never prompts for a passphrase: an encrypted or missing private
key has to be loaded in an unlocked agent.

Setup writes configuration and registers the key. It does not test the connection or check the
gateway's host key. OpenSSH accepts an unknown host key on the first connection and refuses a
changed one, and Mend never clears `known_hosts`.

Run **Mend: Set up workspace SSH**, or `mend ssh setup` in a terminal, to redo it. The SSH hostname
comes from the Mend server URL, and the server supplies the port. Set `mend.workspaceSshHost` to use
another hostname.

### Removing a key

Each machine that ran setup registered its own key with your account. To stop a machine opening
workspaces, for a lost laptop, remove its key under **Settings → Workspace SSH** in the web app, or
from any signed-in terminal:

```sh
mend ssh keys                   # every key you registered; the one this machine offers is marked
mend ssh keys remove SHA256:…   # the SHA256: prefix is optional
```

The gateway checks a key on every new connection, so the next Remote-SSH connection with a removed
key is refused. With the Sealant this release pins, the connections already open with that key end
within a minute; against an older Sealant they stay open until the workspaces they reach stop, and
the removal lists your running sessions to stop. You can remove only your own keys; removing a
member from the organization removes theirs, and Mend keeps retrying any key the platform did not
remove at once. `mend uninstall --home` removes the key of the machine it runs on. The mobile app
does not list keys.

## Take over a running session

Opening a session whose agent Mend is running elsewhere, such as a `mend codex` in a terminal or a
session picked up on the phone, asks whether to **Open alongside** it or **Take over in the
editor**. **Mend: Take over session in the editor** on a live session goes straight to the takeover.

The editor cannot attach to Mend's terminal for the agent, so a takeover works like this:

1. A confirmation names the agent that will end and the command that will resume it.
2. Mend opens a shell in the session, which keeps the workspace up, and stops the running agent.
3. The workspace opens in VS Code, or the current window is used when it is already that workspace.
4. A new integrated terminal runs the harness's own resume: `codex resume <id>` or
   `claude --resume <id>`. Without a known id it runs `codex resume --last` or `claude --continue`.

The harness home lives in the workspace, so the resume finds the conversation the agent was writing,
and Mend observes the new process as the same conversation. Cancelling the SSH setup or the
confirmation leaves the agent running. The stop ends only the agent; the shell keeps the workspace
open until you stop the session.

Where the session line says `Remote-SSH: root, Core can't bind your person`, the resume runs as
root, which does not hold your conversation; take such a session over with `mend attach` instead.

Only `claude` and `codex` sessions can be taken over here. The extension says so and gives the
`mend attach` command to use from a terminal instead.

## The session's terminal

**Mend: Open terminal** on a live session opens its terminal in a VS Code terminal tab: the agent's
own terminal, one of the session's shells, or a new shell. It goes over Mend's terminal connection,
the one `mend attach` and the web app use, so it needs no SSH and works wherever the extension
reaches the server: a LAN, a private network or an https edge. It opens for whoever may steer the
session: its owner, and others only while the owner has shared control on, and then they watch; only
the owner types. Closing the tab detaches, and the process keeps running. A dropped connection
reattaches on its own while the process runs, up to five times; a refusal from the server ends it.

## Agents you run yourself

An agent you start by hand in the workspace, in this terminal or in `mend shell`, is not one Mend
started. Mend notices it from the conversation files it writes, and records it as an observed
process (`claude (observed)`) beside the session's other processes:

- **It shows up within about half a minute.** The workspace saves its files a few seconds after a
  write, and Mend looks at the latest save every 20 seconds.
- **It ends after five quiet minutes.** Mend does not see the process exit. Five minutes without a
  write reads as ended, the conversation is recorded, and the session can settle. If the agent
  writes again, Mend observes it again as a new process.
- **Mend cannot steer or stop it.** It has no prompt box, and follow-ups and review comments do not
  reach it. A Stop records it as stopped but does not end the process: exit it in its terminal. If
  it wrote in the last five minutes and a shell or Service still keeps the session's workspace up,
  Mend observes it again as a new process within about 20 seconds. When the workspace itself stops,
  everything running in it ends.
- **Claude Code, Codex and pi only.** opencode keeps its conversations in a database, not in files,
  so an `opencode` you run by hand is not observed.
- **Only while no agent Mend started writes beside it.** In a per-person workspace, that is an agent
  Mend runs as you. In a workspace with one shared home, it is an agent Mend runs in any session of
  the worktree, whoever started it. While one runs, Mend takes the writes for its own.
- **In a [per-person workspace](/operate/per-person-workspaces/)**, an agent you run writes into
  your own saved directory. Mend observes it as yours, in your own sessions only, and never in
  another person's session in the same workspace.

The Claude Code extension for VS Code runs the `claude` it bundles inside the workspace when the
window is connected over Remote-SSH, so its conversations should land where a terminal `claude`'s do
and be observed the same way. This has not been confirmed end to end yet.

To have Mend run the agent, so you can prompt it, follow it, steer it from any device and stop it,
start it from Mend: **+** → an agent, or **Claude agent** / **Codex agent** under
[Start a session](#start-a-session). That is the fully supported path.

## Review a change

**Mend: Review change** opens the session's change in Mend's review, in your browser, at the server
URL the extension uses. A session with no change yet says so.

## Other commands

| Command                         | What it does                                                  |
| ------------------------------- | ------------------------------------------------------------- |
| **Mend: Open in VS Code**       | Open the session's workspace                                  |
| **Mend: Open terminal**         | Open the session's terminal in a VS Code terminal tab         |
| **Mend: Review change**         | Open the session's change in Mend's review                    |
| **Mend: Open in Mend**          | Open the session or project in the web app                    |
| **Mend: Stop session**          | Stop a live session; the worktree and its change remain       |
| **Mend: Show project sessions** | Pick a session of the current project, or start something new |
| **Mend: Refresh**               | Reload the view                                               |
| **Mend: Sign out**              | Forget this editor's token, and revoke it if it signed in     |

A link of the form `vscode://sealant-sh.mend/open?session=<session-id>` opens that session in VS
Code, with the same takeover question for a running agent.

## Sign-in

The extension reads the connection the CLI saved, `$XDG_CONFIG_HOME/mend/cli.json`
(`~/.config/mend/cli.json` by default): its server URL and token. If you ran `mend login` on this
machine, there is nothing to set up. With no URL configured anywhere, it uses
`http://localhost:3105`.

On a machine without the CLI, run **Mend: Connect to server**. It asks for the server URL as this
machine reaches it (`http://mend-mini.local:3105`, a tailnet name, or your edge's `https://`
origin), then how to sign in:

- **Sign in with the browser**: the same walk as `mend login`. The browser opens
  `<server>/authorize`, which asks **Authorize VS Code?**; approve there when it shows the same code
  as VS Code. A notification shows the link and the code from the start, with **Copy link** and
  **Paste a device token instead**, so the sign-in does not depend on VS Code's "open the external
  website?" dialog, which can sit behind other windows. The notification hides after a while; the
  status bar keeps `Mend sign-in · <code>` until the sign-in ends, and clicking it brings the link
  and both actions back. The wait is timed from the server's answer, so a server whose clock is off
  from this machine's (a Mac's Docker VM after sleep) does not expire it early. The editor receives
  its own device token, listed under **Settings → Devices** as `VS Code on <machine>`.
- **Paste a device token**: a token minted in the web app under **Settings → Devices**.
- **No token**: for a local server that does not require one.

The URL is saved as the `mend.serverUrl` setting and the token in VS Code's secret storage
(encrypted, with its key in the macOS Keychain on a Mac). For a plain `http://` URL on another
machine, the extension says so when it asks how to sign in:
`Plain http: anyone on this local network can read the token.` for a LAN address or name, and
`Plain http: the token crosses the network unencrypted.` otherwise. It says nothing for a tailnet
address (`100.64.0.0/10`) or a `.ts.net` name, since the tailnet encrypts the connection. Use a
private network you control or an https edge. The CLI's token is used only while `mend.serverUrl`
points at the same URL as the CLI's configuration. **Mend: Sign out** revokes a token the browser
sign-in created and forgets it; a pasted token stays valid until you revoke it under **Settings →
Devices**. Signed out stays signed out: the editor does not fall back to the CLI's sign-in for that
server until you connect again, and the CLI keeps its own (`mend logout` ends it).

When the server refuses the token, the error offers **Connect to server**. A request that gets no
answer within 30 seconds (a server asleep, a network change) fails with that, and the live view
reconnects on its own once the server answers again.

Running Mend on a Mac mini and VS Code on a laptop, step by step:
[Mac mini and VS Code](/operate/mac-mini-vscode/).

## Install from source

You need a checkout of the repository with its toolchain: Node (the repository pins 26.4.0 in
`.node-version`) and pnpm.

```sh
git clone https://github.com/sealant-sh/Mend.git
cd Mend
pnpm install
cd apps/vscode
pnpm build
pnpm package
code --install-extension mend-*.vsix
```

`pnpm build` bundles the extension into `dist/`, and `pnpm package` writes the `.vsix` named after
the version in `apps/vscode/package.json`. Reload VS Code after installing.
