# Changelog

The extension's version follows the Mend release it needs: 0.36.x works with a Mend 0.36 server. The
patch number is the extension's own.

## Unreleased

- The Mend view is **Sessions**: **Needs you**, **Since you last looked**, **Running**, then
  **Projects**, collapsed. Each row reads `<word> · <fact>` as Mend observed it, such as
  `waiting · claude needs your permission to use Bash · since 02:14` or
  `completed · observed · exited with code 0`. **Since you last looked** lists what completed,
  failed or landed since this VS Code last showed it, kept per server on this machine.
- The badge on the Mend icon counts the sessions that wait for you and that **Answer** lets you
  answer: a terminal agent of your own, or a conversation you may steer. The status bar reads
  `Mend · 1 needs you · 2 finished`. A session's workspace window shows that session only, one line
  for the others, and `● <session> · <word>` in the status bar; both open the session picker.
- A notification shows only in the focused window, only when a session waits for you or a session
  you started finished, and only when that window is not showing it. One wait notifies once across
  your windows. **Answer** attaches the agent's terminal in this window.
- An empty group stays in its place and reads `nothing`, so clicking **Open** on a row while another
  row changes still opens that row's session.
- When Mend cannot be reached the view says when it was last heard, rows keep their last words, and
  **New session** and **Answer** are disabled. The view's **+** then reads
  `Mend is offline · retrying`.
- **Mend: New session** (before, **New Session…**) is one quick input. Type a prompt and press
  Enter: Mend starts claude on it in a new session's terminal, the row shows at once, and no window
  opens. A dim line under the prompt says what Enter starts (`claude · default model · from main`).
  **Change…** steps through harness, model, thinking, permissions and base in the same input, with a
  step counter and Back, and remembers each choice per project. This replaces the pick between
  Workbench, Claude agent, Codex agent and Agent with options…, and its separate prompts.
- A new session starts from the window's branch when origin has its commits. When it does not, it
  starts from the default branch, and the line says so before Enter:
  `from main · your branch fix/login isn't pushed`.
- When no project matches the window, New session lists the projects, with **Adopt this repository**
  on top when the window's origin URL is not adopted.
- A launch that fails reads `failed · <the launch's line>` on its row, and its error notification
  offers **Retry**, which launches the same session again.
- **Mend: New worktree without an agent…** is removed: choose the `shell` harness in **Change…**.
- **Mend: New session in this worktree…** opens the same input. Who else runs in the worktree is on
  its line instead of a dialog.
- The view follows Mend's events by re-reading only the session or project an event names, instead
  of every project. **Mend: Toggle current project scope** is gone.
- **Open** replaces **Open in VS Code**. It follows your `window.openFoldersInNewWindow` setting,
  and **Open in New Window** in the row's right-click menu opens a new one. Neither asks. A stopped
  session is resumed as part of the open; a missing Remote-SSH install or workspace SSH setup runs
  as a step of it; progress shows in the status bar. The one question left is the one-time consent,
  **Set up workspace SSH to open sessions**, when setup never ran on this machine.
- Clicking or double-clicking a session row selects it and never opens a window. Before, a
  double-click opened the workspace twice.
- A session's workspace window attaches the agent's terminal and focuses it (`claude · <session>`).
  A conversation started elsewhere shows **Continue here**, which moves it into a terminal through
  Mend's mode handoff.
- **Take over session in the editor** is removed: typing into the attached terminal does the same,
  and **Continue here** moves a conversation into a terminal and keeps the conversation.
- A row whose workspace someone else launched offers **Review**, and **Watch terminal** while shared
  control is on, instead of an **Open** that Remote-SSH would refuse. Its tooltip says why. When
  Mend cannot read who you are, the row offers **Review** only, an **Open** from elsewhere reads
  again before it opens anything, **Stop** refuses before it asks, and a workspace window attaches
  no agent. **Stop** is offered only on sessions you may steer.
- In a worktree that holds several sessions, the window attaches the agent of the session you
  opened. When that session is gone or has moved, the window attaches no agent and its status bar
  says why. In a window that already holds the session's workspace, Open and Open in New Window both
  show that session's agent, after resuming it if it had stopped: VS Code keeps one window per
  folder.
- Remote-SSH no longer asks for the platform of Mend's host: the open sets it to Linux.

- Cancelling browser sign-in, including choosing **Paste a device token instead**, discards an
  approval that arrives while a poll is pending and revokes its device. If Mend cannot confirm
  revocation, the editor names the device to revoke under Settings → Devices.

## 0.36.1

It needs a Mend 0.36 server.

- Browser sign-in no longer waits on VS Code's "open the external website?" dialog, which can sit
  behind other windows. A notification shows the link and the code from the start, with **Copy
  link** and **Paste a device token instead**. Polling starts at once, so an approval made from the
  copied link counts while that dialog is still open. The notification hides itself after a while,
  so a status bar item keeps the code for the whole sign-in; clicking it brings back the link and
  both actions.
- The approve page names the editor: **Authorize VS Code?**, with the device's name
  (`VS Code on <host>`).
- Sign-in survives a clock that disagrees with the server's (a Mac's VM after sleep): the wait is
  timed from the server's answer, not from this machine's reading of its expiry time.
- The plain-http warning before a token is chosen says nothing for a tailnet address, which encrypts
  the connection itself, and fits the quick pick: "anyone on this local network can read the token"
  for a local address, "the token crosses the network unencrypted" otherwise.
- **Mend: Open in VS Code** is in a session's right-click menu, not only on its row.
- The listing is named **Mend by Sealant**: the Marketplace already had a `Mend`. Inside VS Code the
  views and commands still say Mend.

## 0.36.0

The first version on the Visual Studio Marketplace and Open VSX. It needs a Mend 0.36 server.

- Projects and sessions in the Activity Bar, live, with what waits for you under **Needs you**; the
  view scopes itself to the open folder's project.
- Open a session inside its workspace over Remote-SSH. In a per-person workspace the login is the
  workspace's launcher, as their own user, on their home and logins.
- **Mend: Set up workspace SSH** registers this machine's key and writes one `Host` block for the
  server; it never clears `known_hosts` and never asks for a passphrase.
- Start a Workbench shell, a Claude or Codex agent, or an agent with options (harness, model,
  thinking level, permissions, base branch); start another session in the same worktree; make a
  worktree without an agent.
- Take over an agent running elsewhere: Mend stops it and the editor's terminal resumes the same
  conversation.
- **Mend: Open terminal** attaches to a session's terminal over Mend's terminal connection, without
  SSH.
- **Mend: Connect to server** signs in with the browser, a pasted device token, or none for a local
  server; **Mend: Sign out** revokes a browser sign-in's token.
- **Mend: Review change**, **Mend: Open in Mend**, **Mend: Stop session**, **Mend: Adopt a
  project…**, and `vscode://sealant-sh.mend/open?session=<id>` links.
