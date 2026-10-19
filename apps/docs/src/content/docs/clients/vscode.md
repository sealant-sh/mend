---
title: VS Code extension
description:
  Open Mend sessions in VS Code over workspace SSH, start sessions, and type to a running agent in
  its attached terminal.
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

The Mend icon in the Activity Bar opens **Sessions**. In any window that is not a session's
workspace it has four groups, in this order:

- **Needs you**: sessions that wait for you and that **Answer** lets you answer. Each waits for its
  owner alone, even with shared control on. Only the owner types in a terminal agent's terminal, and
  only the owner gets **Continue here** on a conversation, which is how **Answer** answers its
  request for now. A row says what the session waits for, as Mend observed it:
  `waiting · claude needs your permission to use Bash · since 02:14`. A session that waits for a
  reason Mend has not read yet, or that waits for someone else, stays under **Running**.
- **Since you last looked**: sessions that completed, failed or landed since this VS Code last
  showed them. A session counts as shown once you select its row, or while its workspace window is
  focused. VS Code keeps this per server and per machine. Past eight rows the group lists projects.
- **Running**: sessions that are starting, running or idle. A terminal agent that finished its turn
  reads `idle · claude finished its turn`: it asks nobody, so it is not under **Needs you**.
- **Projects**, collapsed: every project with all of its sessions.

A group with no sessions stays in its place and reads `nothing`.

Every row reads `<word> · <fact>` as Mend observed it, for example `completed · observed`,
`failed · exit 1 at 03:40` or `landed by Ana · pull request #415 · merged · observed`. The Mend icon
shows a badge with the number of sessions under **Needs you**. The status bar says the same in one
item, `Mend · 1 needs you · 2 finished`; clicking it shows the view.

Clicking a row selects it; **Open** is the row's button. **Answer** on a waiting row attaches the
agent's terminal in this window's panel and opens no window.

In a session's workspace window the view shows that session only, and one line for the rest,
`2 other sessions · 1 needs you`. The status bar reads `● add-rate-limit · running`. The line and
the status bar both open the session picker.

Only the focused VS Code window shows a notification, and only when a session waits for you or a
session you started finished, and that window is not already showing it: selected in the view, the
window's own session, or the session whose agent terminal is in front after **Answer**. One wait
shows one notification across all your VS Code windows, and none once it is a week old. Other
windows show the badge. A launch you started that fails, or that the server refuses, is the
exception: its notification shows even while its row is on screen, because only the notification
offers **Retry**. When Mend cannot be reached, the view reads `last heard from Mend at 23:10`, the
rows keep the last words Mend reported with `· last seen 2 min ago`, and **New session** and
**Answer** are disabled.

With no project adopted, the view offers **Adopt a project…**, which asks for a Git clone URL and a
project name.

## Start a session

Click **+** in the view, or run **Mend: New session**. One quick input opens. When the window's
folder is a clone of an adopted project, matched by its origin URL, the input is that project's,
titled `New session · <project>`, and nothing asks which project. Two origins match when they name
the same host and path: `https://`, `ssh://` and `git@host:path` forms are alike, the host is
compared without case, the path exactly, a trailing `.git` is dropped, and a port other than the
scheme's default counts. A folder with an origin never matches a project by its folder name. Where
the folder sits matches only when its Git root is the adopted source itself or one of the project's
worktrees, with symlinks resolved on both sides: a separate repository nested inside the source,
with an origin of its own, is matched by that origin, and gets **Adopt this repository** when it is
not adopted. Type what the agent should do and press Enter. The prompt is an input box, so a pasted
log of any length reaches Mend whole. One line under it says what Enter starts:

```text
claude · default model · from main
```

Mend creates the session (`POST /projects/:id/sessions`) and launches the harness on your prompt as
a terminal agent: the claude TUI in the session's terminal (`POST /sessions/:id/launch`, PTY mode).
The launch is not awaited. The session's row shows in the view at once and reads
`starting · <what it is doing>`, such as `starting · building the workspace image`, until the agent
runs. No window opens and no notification shows. **Open** opens its workspace when you want it. An
empty prompt starts the harness without one.

The line reads `<harness> · <model> · <thinking> · <permissions> · from <base>`, with only the parts
you chose: `default model` until you choose one, `high thinking`, and `asks before acting`.

### The base

A new worktree starts from the window's branch when origin has every commit of it. Mend checks
`origin/<branch>`, else the branch's upstream, with `git merge-base --is-ancestor HEAD`, against
what this machine last fetched; it does not fetch. The upstream is read once, and HEAD is checked
against that commit, so a fetch in between cannot prove a commit that lacks HEAD. A branch on origin
is sent by its name there, so `fix/login` tracking `origin/main` starts from `main`, and the line
reads `from main`. The server resolves the name on origin when it creates the worktree; origin
moving on since the check only adds commits after the one that holds HEAD, unless someone rewrote
the branch. An upstream on another remote is sent as the commit HEAD was checked against, and the
line reads `from upstream/main`.

When origin lacks commits of the branch, or the branch has no remote-tracking ref, the session
starts from the project's default branch and the line says so before you press Enter:
`from main · your branch fix/login isn't pushed`, or
`from main · your commits on main aren't pushed` on the default branch itself. When git does not
answer within 3 seconds, fails, or says no in a shallow clone, whose boundary can hide that HEAD is
on origin, the line reads `from main · couldn't read your branch`. When the server's store does not
know the ref at create, even after fetching origin, the input stays open with your prompt and the
line reads `from main · Mend's store couldn't find fix/login`; Enter then starts from the default
branch. Any other failure to create, such as a fetch or `git worktree add` failing, shows its own
reason and keeps your prompt and your base. A window on another repository, or on a detached HEAD,
starts from the default branch.

### Change…

**Change…**, the gear on the input's title bar, steps through the options as lists in the same
place, with a step counter and Back:

- **Harness**: claude, codex, opencode, pi, or shell. A `shell` session runs no agent: what you type
  names it, and its shell holds the workspace. Mend observes and records what you run there, within
  the limits under [Agents you run yourself](#agents-you-run-yourself).
- **Model**: `default model` first, then the server's list, the same one every other client offers.
  `default model` sends no model: Claude Code runs the model your Claude settings name, else its own
  default, as a `claude` you run yourself does, and opencode's config decides. The step shows before
  the list arrives, with `default model` and your remembered model. Once the list is read, a
  remembered model it no longer has is dropped, and the line says so once:
  `· the server no longer lists <model>`.
- **Thinking**: the levels the model takes, or the harness's default. A model that takes none has no
  thinking step.
- **Permissions**: skip permission prompts, or ask before acting. A shell has no permissions step.
- **Base**: this window's branch (its line says what that resolves to), the default branch, or a
  branch or commit you type. A session in an existing worktree has no base step.

Each choice is remembered at once, for that project on this server, on this machine. The current
choice is checked and reads `remembered for <project>`. After the last step the prompt comes back
with what you typed, and the line reads your choices.

### When it can't start

- **No project matches the window.** The first step lists the projects, with **Adopt this
  repository** on top when the window's origin URL is set and not adopted. Adopting clones it
  (`POST /projects`) while the input waits, then goes on to the prompt.
- **Mend is offline.** **New session** is disabled; the view's **+** reads
  `Mend is offline · retrying`. An input already open says the same on its line, and Enter does
  nothing. What you typed is kept, per project, for the next **New session** in this window.
- **More than one project has the window's origin.** The first step lists those projects only.
- **The prompt can't be one argument.** A prompt with a NUL, one that starts with `-`, or one over
  120,000 UTF-8 bytes is not sent: the line under it turns to a warning that says why, such as
  `the prompt is 130,000 bytes · claude takes at most 120,000`, and Enter keeps the input open with
  the prompt. The prompt reaches the agent as one argument, and Linux takes at most 131,072 bytes
  per argument.
- **The launch fails.** The row reads what the server holds. A launch the server refused while it
  still reads the session `starting` reads `starting · launch refused · <its words>`, such as
  `starting · launch refused · Connect Claude to start a session here. …`. One that failed reads
  `failed · <the launch's line>`. An error notification says so and offers **Retry** when a read of
  the session just then says it failed, or that the refused launch never started. Retry reads it
  again before it sends, and launches the same session again. A session that reads `starting` under
  another launch, or runs, is never sent again: a launch whose answer was lost, or that an edge
  answered with a 5xx, may be running. Retry shows only in the window that launched it. A failure
  the server settled shows one notification across your VS Code windows, the launching one included.

**Mend: New session in this worktree…** on a session opens the same input for a second session in
the same worktree: the same files and branch, with a new conversation. Its title ends
`· in <worktree>`, or `· in <session>'s worktree` for a worktree with no name of its own, its line
reads the same, and when another person's session runs there the line says so. Each session keeps
its own harness state, so the new session does not see the first session's conversation. To continue
that conversation, open that session.

## Open a session

**Open**, the window button on a session's row (or **Mend: Open**), makes a VS Code window the
session's workspace. It follows your `window.openFoldersInNewWindow` setting; **Open in New
Window**, in the row's right-click menu, opens a new one. VS Code keeps one window per folder, so
when a window already holds the session's workspace, both focus that window and show the session's
agent. Neither asks a question, and clicking the row only selects it. A second **Open** while one
runs shows the first one's progress.

The status bar shows the open as it goes. A settled session is resumed as a workbench shell first
(`starting <session>'s workspace · 20 s`): the shell starts a fresh workspace over the same worktree
and keeps it up while the editor is attached, and no agent is launched. A missing Remote-SSH install
or workspace SSH setup runs as a step of the same open, and the Remote-SSH platform for Mend's host
is set to Linux so Remote-SSH does not ask. Opening from the window that already is the workspace
focuses its agent's terminal, after resuming the session if it had stopped. When the session a
window was opened for is gone or has moved, the window attaches no agent and its status bar says
why. A failure shows one error with **Retry** or **Set up**.

In a [per-person workspace](/operate/per-person-workspaces/) only the workspace's launcher can open
it over Remote-SSH: the person whose session started the workspace. A session started in a worktree
where someone else's session already runs joins their workspace, so it is theirs to open, your own
session included. Its row offers **Review** instead of **Open**, and **Watch terminal** while its
owner has shared control on; the row's tooltip says why. The Remote-SSH login runs as the launcher's
own Linux user, on their home and logins, so an agent they start in its terminal runs as them. Where
the server's Sealant cannot bind the person (an older Core), it runs as root instead, and the
session line says `Remote-SSH: root, Core can't bind your person`; an agent started there then does
not use the person's home and logins.

### Workspace SSH setup

The first open asks once: **Set up workspace SSH to open sessions (one Host block in
~/.ssh/config)**. Setup registers this machine's SSH public key with Mend and adds one
server-specific `Host` block at the start of `~/.ssh/config`, before any wildcard entries. It keeps
hand-written configuration and blocks for other Mend servers. On later runs it reuses the key it
chose. On first setup it can use a key from your SSH agent or create a dedicated key under
`~/.config/mend/ssh`. It never prompts for a passphrase: an encrypted or missing private key has to
be loaded in an unlocked agent.

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

## Type to the agent

The workspace window attaches the session's agent terminal in its panel and focuses it, named
`<harness> · <session>` (`claude · add-rate-limit`), over Mend's terminal connection. Driving by
hand is typing into it: the same agent and conversation, nothing restarted. A workbench shows its
shell (`shell · <session>`). The session's owner types; anyone else the server lets in reads
`read-only · <owner>'s session`.

A conversation started on the phone, the web or Slack has no terminal yet. Its tab reads
`claude is running as a conversation (from …) · Continue here to type to it`. **Continue here**
moves the same conversation into a terminal with Mend's mode handoff, and the tab becomes that
terminal. A harness the handoff does not support reads
`opencode can't continue in a terminal yet · open the terminal to watch`.

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
- **It ends five minutes after its last write, which can be a few minutes after your last turn.**
  Mend does not see the process exit. Five minutes without a write reads as ended, the conversation
  is recorded, and the session can settle. The agents write after a turn too: Claude Code writes a
  summary about three minutes after it, so a Claude Code you leave reads as ended about eight
  minutes after your last turn. Commands such as `/status` and `/exit` are writes as well. When the
  agent writes again, Mend observes it again as a new process.
- **Mend cannot steer it.** It has no prompt box, and follow-ups and review comments do not reach
  it. A Stop records it as stopped. Whether the agent itself ends depends on where it runs:
  - In a terminal Mend opened for the session (`mend shell`, a shell opened on the web, or a shell
    session's own shell), a Stop that ends no agent Mend started closes those terminals, and the
    agent in them ends with them, even while a Service keeps the workspace up. A Stop that does end
    an agent Mend started keeps your terminals; a second Stop closes them.
  - In a terminal of your own, such as VS Code's over Remote-SSH, a Stop does not touch it: exit it
    there. If it wrote in the last five minutes and a shell or Service still keeps the session's
    workspace up, Mend observes it again as a new process within about 20 seconds.

  When the workspace itself stops, everything running in it ends.

- **Claude Code, Codex and pi only.** opencode keeps its conversations in a database, not in files,
  so an `opencode` you run by hand is not observed.
- **Only while no agent Mend started writes beside it.** In a per-person workspace, that is an agent
  Mend runs as you. In a workspace with one shared home, it is an agent Mend runs in any session of
  the worktree, whoever started it. While one runs, Mend takes the writes for its own.
- **In a [per-person workspace](/operate/per-person-workspaces/)**, an agent you run writes into
  your own saved directory. Mend observes it as yours, in your own sessions only, and never in
  another person's session in the same workspace.
- **Codex runs without its own sandbox**, as every Codex session Mend starts does, in a terminal or
  a conversation, asking before acting or not: the workspace is the sandbox, and Codex's
  (bubblewrap) cannot start in one. Mend sets this as Codex's system default
  (`/etc/codex/config.toml`) when the workspace starts, where no such file is. A `sandbox_mode` in
  your own `~/.codex/config.toml` wins over it, and a sandboxed mode there leaves Codex unable to
  run a command. Approvals stay Codex's own default.
- **Claude Code opens on your own model.** A Claude launch of Mend's writes one key into
  `~/.claude/settings.json`, `skipDangerousModePermissionPrompt`, and never a model. It takes out
  `claude-fable-5`, the model Mend itself wrote there until 2026-10-01. So a `claude` you run
  yourself, and the extension's panel, open on the model your settings name, else Claude Code's own
  default, and Mend's launches do the same unless you pick a model for one.

The Claude Code extension for VS Code runs the `claude` it bundles inside the workspace when the
window is connected over Remote-SSH. Its conversations land where a terminal `claude`'s do, and Mend
observes them the same way, as you: a turn in the panel showed up after 8 s on 0.36.

To have Mend run the agent, so you can prompt it, follow it, steer it from any device and stop it,
start it from Mend: **+**, a prompt and Enter, under [Start a session](#start-a-session). That is
the fully supported path.

## Review a change

**Mend: Review change** opens the session's change in Mend's review, in your browser, at the server
URL the extension uses. A session with no change yet says so.

## Other commands

| Command                         | What it does                                                  |
| ------------------------------- | ------------------------------------------------------------- |
| **Mend: Open**                  | Open the session's workspace, as your window setting says     |
| **Mend: Open in New Window**    | Open the session's workspace in a new window                  |
| **Mend: Answer**                | Attach a waiting session's agent terminal in this window      |
| **Mend: Choose a session**      | Pick a session that needs you, finished or runs               |
| **Mend: Open terminal**         | Open the session's terminal in a VS Code terminal tab         |
| **Mend: Review change**         | Open the session's change in Mend's review                    |
| **Mend: Open in Mend**          | Open the session or project in the web app                    |
| **Mend: Stop session**          | Stop a live session; the worktree and its change remain       |
| **Mend: Show project sessions** | Pick a session of the current project, or start something new |
| **Mend: Refresh**               | Reload the view                                               |
| **Mend: Sign out**              | Forget this editor's token, and revoke it if it signed in     |

A link of the form `vscode://sealant-sh.mend/open?session=<session-id>` runs **Mend: Open** on that
session.

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
