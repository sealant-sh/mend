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

If you ran `mend login` on this machine, there is nothing to set up: the extension reads the CLI's
connection from `~/.config/mend/cli.json`. With nothing configured, it uses `http://localhost:3105`.

Otherwise run **Mend: Connect to server** and enter the server URL as this machine reaches it, then
pick how to sign in:

- **Sign in with the browser**: the browser opens `<server>/authorize`. Approve there when it shows
  the same code as VS Code. The editor gets its own device token, listed under **Settings →
  Devices** as `VS Code on <machine>`.
- **Paste a device token** minted in the web app under **Settings → Devices**.
- **No token**, for a local server that does not require one.

The token is kept in VS Code's secret storage. For a plain `http://` URL on another machine the
extension says so before you sign in: the token would cross that network unencrypted. **Mend: Sign
out** revokes a browser sign-in's token and forgets it.

## Open a session over Remote-SSH

The Mend icon in the Activity Bar opens **Projects and sessions**: sessions waiting for you under
**Needs you**, then each project with its sessions and their status. **Open** on a session's row
opens it.

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

Click **+** in the view, or run **Mend: New Session…**:

- **Workbench**: a fresh worktree held open by a shell. VS Code opens in it, and you run `claude` or
  `codex` yourself in the terminal.
- **Claude agent** or **Codex agent**: Mend starts the agent on your prompt, and the workspace opens
  beside it.
- **Agent with options…**: harness, model, thinking level, permissions and base branch.

**Mend: New session in this worktree…** starts another session on the same files and branch, with a
new conversation.

## Open

**Open**, the window button on a session's row (or **Mend: Open**), makes a VS Code window the
session's workspace. It follows your `window.openFoldersInNewWindow` setting. **Open in New
Window**, in the row's right-click menu, always opens a new one. Neither asks a question. Clicking
the row only selects it.

The status bar shows the open's progress. A stopped session is resumed as a workbench shell first
(`starting <session>'s workspace · 20 s`). A missing Remote-SSH install or workspace SSH setup runs
as a step of the same open. Opening the window that already is the workspace focuses its agent's
terminal.

In the workspace window the agent's terminal is attached in the panel and focused, named
`<harness> · <session>`, so driving by hand is typing into it. A conversation started on the phone,
the web or Slack has no terminal yet: its tab reads
`claude is running as a conversation (from …) · Continue here to type to it`, and **Continue here**
moves the same conversation into a terminal through Mend's mode handoff (claude and codex). Someone
else's session reads `read-only · <owner>'s session`.

## Other commands

| Command                         | What it does                                                  |
| ------------------------------- | ------------------------------------------------------------- |
| **Mend: Open terminal**         | The session's terminal in a VS Code terminal tab, without SSH |
| **Mend: Review change**         | The session's change in Mend's review, in your browser        |
| **Mend: Open in Mend**          | The session or project in Mend's web app                      |
| **Mend: Stop session**          | Stop a live session; the worktree and its change remain       |
| **Mend: Adopt a project…**      | Adopt a repository from its clone URL                         |
| **Mend: Show project sessions** | Pick a session of the current project, or start something new |
| **Mend: Copy worktree path**    | Copy the worktree's path on the server                        |

A link of the form `vscode://sealant-sh.mend/open?session=<session-id>` opens that session.

## Settings

- `mend.serverUrl`: the Mend server URL. Empty uses the CLI's configuration, then
  `http://localhost:3105`.
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
