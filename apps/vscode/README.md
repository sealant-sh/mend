# Mend for VS Code

[Mend](https://mend.run) is a local-first workbench for people who work with coding agents. It runs
your own agent (Claude Code, Codex, or any command) in a recorded git worktree on a Mend server, and
shows the change it made with the evidence behind it.

This extension lists your Mend projects and sessions in VS Code and opens a session inside its
workspace over Remote-SSH. The editor's files are the session's worktree, and the integrated
terminal runs in the workspace: its image, its environment, and the session's harness home. A
`claude` or `codex` you start in that terminal is observed by Mend. The session shows running, the
workspace stays up, and the conversation is recorded and can be resumed from any device.

## Requirements

- A Mend server, version 0.36 or newer, with a workspace SSH gateway. Install one with
  `npm install --global @sealant/mend` and `mend server setup`; see
  [Install](https://docs.mend.run/getting-started/install/).
- VS Code 1.100 or newer.
- Microsoft's
  [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh)
  extension, to open a session's workspace. Without it, opening a session offers to install it, or
  copies the `code --remote …` command that opens the same folder.

## Sign in

The Mend view says `Connect VS Code to your Mend server.` with **Connect**. If you ran `mend login`
on this machine, it offers **Use it** instead, with the CLI's server and account: one click, no URL
and no browser.

**Connect** asks for the server URL as this machine reaches it, then opens `<server>/authorize` in
your browser. Approve there when it shows the same code as VS Code's notification. One notification
confirms it, `Signed in to <server> as <you>`, and the account shows in VS Code's Accounts menu. The
editor gets its own device token, listed under **Settings → Devices** as `VS Code on <machine>`.

The token is kept in VS Code's secret storage. For a plain `http://` URL on another machine the URL
input says `Plain http: the token travels unencrypted` before anything is sent. **Sign Out** in the
Accounts menu, or **Mend: Sign out**, revokes the editor's device and forgets it. When Mend refuses
the token (its device revoked under **Settings → Devices**), the editor forgets it too, and one
notification offers **Connect to server**.

Next, **Set up** installs Remote-SSH if it is missing, registers an SSH key and writes one `Host`
block to `~/.ssh/config`, once; no open asks again. **Skip for now** leaves it to the first open,
which asks once.

## Open a session over Remote-SSH

The Mend icon in the Activity Bar opens **Sessions**: **Needs you**, **Since you last looked**,
**Running**, then **Projects**, collapsed. The badge counts the sessions that wait for you, and the
status bar says `Mend · 1 needs you · 2 finished`. **Open** on a session's row opens it. **Answer**
on a waiting row attaches its agent's terminal in this window.

The first open asks once: **Set up workspace SSH to open sessions (one Host block in
~/.ssh/config)**. Setup registers this machine's SSH public key with Mend and adds one `Host` block
for this server at the start of `~/.ssh/config`. It keeps your own configuration. It uses a key from
your SSH agent or creates one under `~/.config/mend/ssh`, and never asks for a passphrase. Run
**Mend: Set up workspace SSH**, or `mend ssh setup`, to redo it.

In a per-person workspace, the 0.36 default, the Remote-SSH login is the workspace's launcher, as
their own Linux user, on their home and logins. Only the launcher can open that workspace over
Remote-SSH, so a row whose workspace someone else launched offers **Review** instead, and **Watch
terminal** while its owner has shared control on. Its tooltip says why.

The extension never opens the worktree's path on the Mend host instead. A terminal there would run
outside the workspace, where Mend does not see it. When the server has no workspace SSH gateway, the
open stops with a message.

## Start a session

Click **+** in the view, or run **Mend: New session**. One quick input opens on the project whose
origin URL matches the window's folder, titled `New session · <project>`. Type what the agent should
do and press Enter. One dim line under the prompt says what Enter starts:
`claude · default model · from main`.

Mend creates the session and launches claude on your prompt in the session's terminal. Its row shows
in the view at once and reads `starting · <what it is doing>` until the agent runs. No window opens
and no notification shows. **Open** opens its workspace when you want it.

- The base is the window's branch on origin (`origin/<branch>`, else its upstream) when that has its
  commits, sent as that ref: `fix/login` tracking `origin/main` starts from `main`. When it does
  not, the session starts from the default branch, and the line says so before you press Enter:
  `from main · your branch fix/login isn't pushed`. When git does not answer within 3 seconds the
  line reads `from main · couldn't read your branch`. Mend reads what this machine last fetched and
  does not fetch.
- **Change…**, the gear on the line, steps through harness, model, thinking, permissions and base in
  the same input, with a step counter and Back. Each choice is remembered for the project on this
  machine. The harness `shell` runs no agent: what you type names the session, and its shell holds
  the workspace.
- When no project matches the window, the first step lists the projects, with **Adopt this
  repository** on top when the window's origin URL is not adopted.
- While Mend is offline the line reads `Mend is offline · retrying` and Enter does nothing. What you
  typed is kept for the next **New session**.
- A prompt with a NUL, one that starts with `-`, or one over 120,000 UTF-8 bytes is not sent, and
  the line says why: the prompt reaches the agent as one argument.
- When the launch fails, the row reads what the server holds: `failed · <the launch's line>`, or
  `starting · launch refused · <its words>` while the server still reads a refused launch starting.
  An error notification offers **Retry** when a read just then says it failed or never started.
  Retry launches the same session again, and never while it runs or reads starting under another
  launch.

**Mend: New session in this worktree…** opens the same input for another session on the same files
and branch, with a new conversation. Its line reads `in <worktree>`, and says who else runs there.

## Open

**Open**, the window button on a session's row (or **Mend: Open**), makes a VS Code window the
session's workspace. It follows your `window.openFoldersInNewWindow` setting. **Open in New
Window**, in the row's right-click menu, opens a new one. VS Code keeps one window per folder, so
when a window already holds the session's workspace, both focus that window and show the session's
agent. Neither asks a question. Clicking the row only selects it.

The status bar shows the open's progress. A stopped session is resumed as a workbench shell first
(`starting <session>'s workspace · 20 s`). A missing Remote-SSH install or workspace SSH setup runs
as a step of the same open. Opening the window that already is the workspace focuses its agent's
terminal, after resuming the session if it had stopped. When the session a window was opened for is
gone or has moved, the window attaches no agent and its status bar says why.

In the workspace window the agent's terminal is attached in the panel and focused, named
`<harness> · <session>`, so driving by hand is typing into it. A conversation started on the phone,
the web or Slack has no terminal yet: its tab reads
`claude is running as a conversation (from …) · Continue here to type to it`, and **Continue here**
moves the same conversation into a terminal through Mend's mode switch (claude and codex). Someone
else's session reads `read-only · <owner>'s session`.

## Other commands

| Command                         | What it does                                                  |
| ------------------------------- | ------------------------------------------------------------- |
| **Mend: Answer**                | A waiting session's agent terminal in this window's panel     |
| **Mend: Choose a session**      | Pick a session that needs you, finished or runs               |
| **Mend: Open terminal**         | The session's terminal in a VS Code terminal tab, without SSH |
| **Mend: Review change**         | The session's change in the Change section, in VS Code        |
| **Mend: Open in Mend**          | The session or project in Mend's web app                      |
| **Mend: Stop session**          | Stop a live session; the worktree and its change remain       |
| **Mend: Adopt a repository…**   | Adopt a repository from its clone URL                         |
| **Mend: Show project sessions** | Pick a session of the current project, or start something new |
| **Mend: Copy worktree path**    | Copy the worktree's path on the server                        |

A link of the form `vscode://sealant-sh.mend/open?session=<session-id>` opens that session.

## Settings

- `mend.serverUrl`: the Mend server URL, written by **Connect** and **Use it**. Empty means not
  connected.
- `mend.workspaceSshHost`: another SSH hostname for the server, for networks where the URL's
  hostname does not reach the SSH port.

## More

- Full guide: [VS Code extension](https://docs.mend.run/clients/vscode/)
- A server on another machine, step by step:
  [Mac mini and VS Code](https://docs.mend.run/operate/mac-mini-vscode/)
- Issues: [github.com/sealant-sh/Mend/issues](https://github.com/sealant-sh/Mend/issues)
- Source: [apps/vscode](https://github.com/sealant-sh/Mend/tree/main/apps/vscode), Apache-2.0

To build the extension from source, run `pnpm install`, then `pnpm --filter mend build` and
`pnpm --filter mend package` in a checkout, and install the `.vsix` with **Extensions: Install from
VSIX…**.
