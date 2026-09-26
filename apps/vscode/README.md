# Mend for VS Code

Use VS Code as a quiet front door to Mend projects and coding-agent sessions.

The core loop: click **+** in the Mend view → pick **Workbench** (a fresh worktree that opens in VS
Code — run `claude` or `codex` yourself in the terminal, Mend observes and records it) or a
**Claude/Codex agent** on a prompt. Either way a window opens inside the session's workspace. Click
any existing session to open it the same way.

- Browse projects and sessions from the Mend Activity Bar view.
- Open a session's workspace over SSH, through the Mend server's workspace gateway.
- Start Claude or Codex sessions without building harness arguments in the extension.
- Open the canonical session and review surfaces in Mend.

The extension reads the same `~/.config/mend/cli.json` connection used by the Mend CLI. Run
`Mend: Connect to server` to override it. Remote opening requires the Microsoft Remote SSH
extension.

The extension is not published to the Visual Studio Marketplace. Build a `.vsix` with
`pnpm --filter mend build` followed by `pnpm --filter mend package`, and install it with
**Extensions: Install from VSIX…**.

## Opening the workspace (recommended)

Opening a session opens its workspace: the same worktree files, but the integrated terminal runs
inside the workspace — its image, its environment, and the session's harness home (the directory
that holds the harness's state and conversations, captured with the workspace and restored when the
session launches again). A `claude` or `codex` you run there is observed by Mend: the session shows
running, the workspace stays leased, and the conversation is recorded and natively resumable from
any device. A settled session offers a shell resume first — the shell keeps the fresh workspace
alive while the editor is attached.

The first open offers "Set up workspace SSH?" Mend registers this client's key and adds a
server-specific Host block at the start of `~/.ssh/config`, before wildcard defaults. Existing
hand-written configuration is preserved. Setup reuses the selected key on later runs. On first setup
it can save an agent public-key selector or create a dedicated key under `~/.config/mend/ssh`. An
encrypted or missing private key requires that exact identity in an unlocked agent, not just any
agent key. Setup never prompts for a passphrase.

Re-run with `Mend: Set up workspace SSH` or `mend ssh setup`. The SSH hostname comes from the
configured Mend URL; the server publishes the port. `mend.workspaceSshHost` overrides the hostname
for unusual networks.

Setup reports configuration and client-key registration only. It does not test a connection or
verify the gateway's host key. OpenSSH accepts a previously unknown host key on first connection and
rejects changed keys. Mend never clears `known_hosts`. For a host-key mismatch, follow the
[fingerprint verification and manual rotation procedure](../cli/README.md#gateway-host-key-rotation)
before removing only this server's HostKeyAlias entry.

There is no host-path fallback. A missing gateway, a failed discovery, or an authentication error
stops the open with a message instead of opening a folder on the host, where a terminal would run
outside Mend's observation. `Mend: Copy worktree path` still copies the server-side path for your
own use.

## Taking over a running session

Opening a session whose agent Mend is running elsewhere — a `mend codex` in a terminal, a pickup
from the phone — asks whether to open **alongside** it or **take it over in the editor**. The editor
has no terminal client for Mend's PTY, so a takeover goes the observed route: a shell holds the
workspace lease, the running agent is stopped, the workspace opens (or the current window is
reused), and a new integrated terminal runs the harness's own resume — `codex resume <id>` or
`claude --resume <id>` (the most recent conversation when the id is not yet known). The shell keeps
the same workspace, and with it the session's harness home, so that resume finds the conversation
the agent was writing a moment ago, and Mend observes the new process under the same conversation.
`Mend: Take over session in the editor` on a live session does the same without the question.

Cancelling the SSH setup or the confirmation leaves the agent running. The stop ends only the agent:
the shell keeps the workspace open until you stop the session again.

## Another session in the same worktree

`Mend: New session in this worktree…` on a session starts a second session inside the same worktree
— the same files and branch, a new conversation. Each session owns its own harness state, so a
sibling does not see the first session's conversation; to continue that one, take it over instead.

Deep links: `vscode://sealant-sh.mend/open?session=<session-id>`
