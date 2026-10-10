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
terminal runs in the workspace, with the workspace image, environment and harness home. A `claude`
or `codex` you run in that terminal is observed by Mend: the session shows running, the workspace
stays up, and the conversation is recorded and can be resumed from any device.

The extension is not published on the Visual Studio Marketplace. Build and install it from source as
described [below](#install-from-source).

## Requirements

- VS Code 1.100 or newer.
- Microsoft's Remote - SSH extension (`ms-vscode-remote.remote-ssh`). Without it, opening a session
  offers **Install Remote SSH** or **Copy code command**, which copies the `code --remote …` command
  that opens the same folder.
- A Mend server with a workspace SSH gateway. When the server reports none, the extension says
  `This Mend deployment exposes no workspace SSH gateway.` and opens nothing.

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
  you run `claude` or `codex` yourself in the terminal. Mend observes and records it.
- **Claude agent** or **Codex agent**: Mend starts the harness on a prompt you type, and the
  workspace opens in VS Code beside it. An empty prompt starts the harness without one.
- **Agent with options…**: choose the harness, model, thinking level, permissions (skip permission
  prompts, or ask before acting) and base branch. The model list is the server's, the same one every
  other client offers, with the server's default listed first.

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
key is refused. A window already connected stays connected until it disconnects or the workspace
stops. You can remove only your own keys; removing a member from the organization removes theirs,
and Mend keeps retrying any key the platform did not remove at once. `mend uninstall --home` removes
the key of the machine it runs on. The mobile app does not list keys.

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
  `<server>/authorize`; approve there when it shows the same code as the notification in VS Code.
  The editor receives its own device token, listed under **Settings → Devices** as
  `VS Code on <machine>`.
- **Paste a device token**: a token minted in the web app under **Settings → Devices**.
- **No token**: for a local server that does not require one.

The URL is saved as the `mend.serverUrl` setting and the token in VS Code's secret storage (the
macOS Keychain on a Mac). For a plain `http://` URL on another machine, the extension says so before
you sign in: the token crosses that network unencrypted, so use a private network you control or an
https edge. The CLI's token is used only while `mend.serverUrl` points at the same URL as the CLI's
configuration. **Mend: Sign out** revokes a token the browser sign-in created and forgets it; a
pasted token stays valid until you revoke it under **Settings → Devices**. Signed out stays signed
out: the editor does not fall back to the CLI's sign-in for that server until you connect again, and
the CLI keeps its own (`mend logout` ends it).

When the server refuses the token, the error offers **Connect to server**. A request that gets no
answer within 30 seconds (a server asleep, a network change) fails with that, and the live view
reconnects on its own once the server answers again.

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
code --install-extension mend-0.1.0.vsix
```

`pnpm build` bundles the extension into `dist/`, and `pnpm package` writes the `.vsix` named after
the version in `apps/vscode/package.json`. Reload VS Code after installing.
