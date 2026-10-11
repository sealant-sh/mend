# Changelog

The extension's version follows the Mend release it needs: 0.36.x works with a Mend 0.36 server. The
patch number is the extension's own.

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
