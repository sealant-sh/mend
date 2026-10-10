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
**Needs you**, then each project with its sessions and their status. Click a session to open it.

The first open asks **Set up workspace SSH?**. Setup registers this machine's SSH public key with
Mend and adds one `Host` block for this server at the start of `~/.ssh/config`. It keeps your own
configuration. It uses a key from your SSH agent or creates one under `~/.config/mend/ssh`, and
never asks for a passphrase. Run **Mend: Set up workspace SSH**, or `mend ssh setup`, to redo it.

In a per-person workspace, the 0.36 default, the Remote-SSH login is the workspace's launcher, as
their own Linux user, on their home and logins. Only the launcher can open that workspace over
Remote-SSH.

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

## Take over a running session

Opening a session whose agent runs elsewhere (a `mend codex` in a terminal, a session picked up on
the phone) asks whether to **Open alongside** it or **Take over in the editor**. A takeover stops
the running agent, keeps the workspace up with a shell, opens it, and runs the harness's own resume
in a new terminal: `codex resume <id>` or `claude --resume <id>`. The conversation continues in the
editor, and Mend records it as the same conversation.

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
