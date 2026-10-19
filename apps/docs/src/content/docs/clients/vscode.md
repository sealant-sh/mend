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

With no project adopted, the view offers to adopt the window's repository in one click, named after
it and adopted from its origin. A window with no repository offers **Adopt a repository…**, which
asks for a Git clone URL; the project takes the repository's name.

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

Right after you connect, the view offers **Set up**, the only consent the extension asks for, once
per server. One click installs Microsoft's Remote-SSH if it is missing, registers this machine's SSH
key, writes one `Host` block to `~/.ssh/config`, and sets Remote-SSH's platform for that host to
Linux. No open asks again after it. If you skip it, everything but **Open** works, and the first
open asks once: **Set up workspace SSH to open sessions (one Host block in ~/.ssh/config)**. Setup
registers this machine's SSH public key with Mend and adds one server-specific `Host` block at the
start of `~/.ssh/config`, before any wildcard entries. It keeps hand-written configuration and
blocks for other Mend servers. On later runs it reuses the key it chose. On first setup it can use a
key from your SSH agent or create a dedicated key under `~/.config/mend/ssh`. It never prompts for a
passphrase: an encrypted or missing private key has to be loaded in an unlocked agent.

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

Review happens in VS Code. Select a session's row and the **Change** section under the Sessions view
shows its change; in a session's workspace window it shows that session's change with nothing
selected. A stopped session reviews the same way: no live workspace is needed. While first run shows
a step (Connect, Set up, Adopt), the Change section is hidden, and signing out clears it.

- The header reads the slice and what Mend observed of it, for example
  `main → now · 4 files · +120 −18 · observed · 40 s ago`. Mend pins the slice when you first select
  the session (base to a checkpoint taken then), and the same slice shows after a reload and in
  every window. When Mend lists only the first files of a large slice, the header says
  `listing cut at 200 files` instead of `observed`.
- When the worktree moves on after the slice was pinned, the slice stays as it was and the section
  says `worktree changed since this review · 3 new files`. **Review the newer change** pins a new
  slice of the worktree as it is now; reloads and other windows show that one.
- Each file is a row with its letter (**A**, **M**, **D**). Clicking it opens VS Code's own diff
  editor, base on the left and the pinned checkpoint on the right, titled
  `limit.ts (main ↔ checkpoint 6)`. The files are read-only documents read from Mend; what was read
  stays readable while Mend is offline, for the account that read it. A file larger than 1 MiB is
  not shown: Mend reads a file only up to 1 MiB, so its sides say so instead of comparing part of
  it.
- **Open all changes** in the section's title opens every file in one multi-diff editor.
- Click the header to choose what to review: **main → now**, **since my last review** (from the
  checkpoint your own last sent review was pinned to), **last turn** (from the checkpoint before the
  agent's last completed turn to the one taken when it ended), or **between two checkpoints…**. Each
  choice says its two checkpoints and its file count, and keeps them: when newer checkpoints arrive,
  the section offers `newer checkpoints · read checkpoint 4 → checkpoint 7`. A slice other than
  `main → now` can be read but not commented on; the section says
  `viewing · comments go on main → now`. A slice that can no longer be read goes back to
  `main → now` and says why.
- **Comments** and **Checkpoints** list the change's comments and its checkpoint chain.
- **Open in Mend (web)** is in the section's `...` menu, and a session row's **Mend: Open in Mend**
  is in the row's right-click menu. No button and no click in the Mend view opens the browser.

**Mend: Review change**, and a row's **Review** button, bring the section on screen for that
session.

### Comments

- Hover a changed line of the `main → now` diff, click **+**, write, and **Add comment**. The
  comment is **pending**: this VS Code holds it, as a pending review in GitHub Pull Requests, and
  Mend does not have it until you send the review. Edit or delete it until then (its pencil and
  trash). Pending comments are kept on this machine per server, account and session, in the
  extension's global storage that every window shares, so they are there after a window reload and
  in your other windows, and two windows writing at once each keep the other's. A session's review
  holds up to 200 pending comments, and one nobody touched for 30 days is let go.
- The Comments panel lists every comment of the change: yours, Mend's drafts, and the ones Mend
  already holds, each with the word for its state (`pending`, `draft`, `sent`, `addressed`).
- **Read this change** (the section's sparkle button) asks Mend to read the change. The section
  reads `Mend is reading · 10:42` while it does. Its findings arrive as threads authored
  `Mend · draft`, each with its evidence (`seq 214 · pnpm test auth · never ran`) and **Show
  record**. **Accept** makes a draft yours, pending like your own comments, and you can edit it
  until you send the review; **Dismiss** removes it. A draft about the change as a whole hangs on
  the change's own note (`the whole change`), with its evidence, Accept and Dismiss; its row under
  **Comments** opens it. Mend writes drafts and evidence, never a verdict. Mend reads with your own
  provider login; when it cannot, one notification says why in Mend's words.
- **Show record** opens, in a read-only editor, the transcript of the session whose run the evidence
  cites, which can be another session of the same worktree. Mend cannot open it at a record entry
  yet, so it opens whole, with the draft's evidence on top. When no session is recorded by that run
  any more (a later resume started a new one), it opens nothing and says so. **Show record** in the
  section's `...` menu opens the selected session's transcript.

### Send the review back

- **Send review** in the section's title opens an editor, `review · <session>.md`, with the
  instruction Mend will send: your comments in the diff's order, each under its file and line, and
  what to do. Edit it freely. **Send to session** in the editor's title sends it.
- Mend records the follow-up with one idempotency key, kept with the review on this machine, so a
  retry never sends a second one.
- While the session's agent runs in a terminal, Mend holds the follow-up `pending` until that agent
  exits. VS Code then attaches the agent's terminal in your panel, as **Answer** does, and pastes
  the review into its input without pressing Enter. The threads read
  `follow-up pending · in claude's terminal`; press Enter in claude to send it.
- Once that agent exits, a review Mend still holds `pending` offers **Retry delivery**, in its
  threads and the section's title: the same key starts the stopped session on the review. Comments a
  held review carries also go out with your next **Send review**, and Mend then replaces the held
  one.
- **Send to session** sends the comments the editor lists. If your comments changed after it opened,
  nothing is sent and your text stays in the editor; open **Send review** again to compose the
  review anew.
- A stopped session starts on the review as its prompt. The threads read `sent` once Mend reads each
  comment back as sent to the session.
- When delivery fails, the threads read `delivery failed · retryable`, one notification says why,
  and **Retry delivery** sends the same key and text again.
- When the agent's next round moves the worktree on, the slice stays pinned and the section adds
  `worktree changed since this review · 3 new files`, with **Review the newer change** (or **since
  my last review** once you sent one). There each sent comment sits at its line; mark it
  **Addressed**, and an addressed one **Reopen**. Mend never says a comment was addressed.
- Offline, **Send review** is disabled and says `Mend is offline; your comments are kept`; the diff
  stays readable and your pending comments stay.
- **Send review** is offered on your own sessions, and on another person's while they have shared
  control on. A terminal agent takes a review from its owner only.

## Other commands

| Command                         | What it does                                                  |
| ------------------------------- | ------------------------------------------------------------- |
| **Mend: Open**                  | Open the session's workspace, as your window setting says     |
| **Mend: Open in New Window**    | Open the session's workspace in a new window                  |
| **Mend: Answer**                | Attach a waiting session's agent terminal in this window      |
| **Mend: Choose a session**      | Pick a session that needs you, finished or runs               |
| **Mend: Open terminal**         | Open the session's terminal in a VS Code terminal tab         |
| **Mend: Review change**         | Show the session's change in the Change section               |
| **Mend: Open in Mend**          | Open the session or project in the web app                    |
| **Mend: Stop session**          | Stop a live session; the worktree and its change remain       |
| **Mend: Show project sessions** | Pick a session of the current project, or start something new |
| **Mend: Refresh**               | Reload the view                                               |
| **Mend: Sign out**              | Forget this editor's token, and revoke it if it signed in     |

A link of the form `vscode://sealant-sh.mend/open?session=<session-id>` runs **Mend: Open** on that
session.

## Sign-in

Until it is connected, the Mend view shows one step at a time.

1. `Connect VS Code to your Mend server.` with **Connect**. When the Mend CLI on this machine is
   signed in (`$XDG_CONFIG_HOME/mend/cli.json`, `~/.config/mend/cli.json` by default), the view
   offers **Use it** instead, with the CLI's server and account beside the view's title
   (`mend-mini.local:3105 · dana@example.com`). **Use it** connects on the CLI's sign-in in one
   click: no URL and no browser.
2. **Connect** asks one thing: the server URL as this machine reaches it
   (`http://mend-mini.local:3105`, a tailnet name, or your edge's `https://` origin), prefilled from
   the CLI's configuration when there is one. For a plain `http://` URL on another machine the input
   says `Plain http: the token travels unencrypted` before anything is sent; you can still go on. It
   says nothing for this machine, a tailnet address (`100.64.0.0/10`) or a `.ts.net` name, since the
   tailnet encrypts the connection.
3. The browser opens the server's `<server>/authorize` page, which asks **Authorize VS Code?**. VS
   Code shows one notification, `Approve in the browser if it shows ABCD-EFGH`, which you can
   cancel, and the status bar keeps `Mend sign-in · ABCD-EFGH` until the sign-in ends; clicking it
   opens the page again, for when VS Code's "open the external website?" dialog sits behind other
   windows. Approve when the page shows the same code. One notification confirms it:
   `Signed in to mend-mini.local as dana@example.com`. A denial, an expired request or a server that
   cannot be reached ends in one error notification with the reason and **Try again**, which asks
   for the URL again with yours filled in.
4. The account shows in VS Code's Accounts menu, as `dana@example.com @ mend-mini.local (Mend)`.
   **Sign Out** there signs this editor out as **Mend: Sign out** does.

The editor receives its own device token, listed under **Settings → Devices** as
`VS Code on <machine>`. The wait is timed from the server's answer, so a server whose clock is off
from this machine's (a Mac's Docker VM after sleep) does not expire it early. The URL is saved as
the `mend.serverUrl` setting and the token in VS Code's secret storage (encrypted, with its key in
the macOS Keychain on a Mac). The CLI's token is used only while `mend.serverUrl` points at the same
URL as the CLI's configuration. **Mend: Sign out** revokes the device the browser sign-in created
and forgets its token, and says what Mend answered: the device revoked, already signed out, or Mend
not reached (then revoke it under **Settings → Devices** yourself). Signed out stays signed out: the
editor does not fall back to the CLI's sign-in for that server until you connect again or press
**Use it**, and the CLI keeps its own (`mend logout` ends it).

When Mend refuses the editor's token, for example after you revoke its device under **Settings →
Devices**, the editor forgets the token: the account leaves the Accounts menu in every VS Code
window, and one notification says `Signed out — sign in again.` with **Connect to server**.
Connecting again while connected revokes the device the new sign-in replaces, so Settings → Devices
keeps one `VS Code on <machine>`.

Next, the view offers `Open sessions in VS Code: needs Remote-SSH and an SSH key for Mend` with
**Set up** (see [Workspace SSH setup](#workspace-ssh-setup)), or **Skip for now**. With no project
yet, it then offers the window's repository, `Adopt` with its name and origin beside the view's
title, or **Adopt a repository…** in a window with none.

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
