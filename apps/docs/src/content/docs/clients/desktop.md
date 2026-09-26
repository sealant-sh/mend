---
title: Desktop app
description:
  The Mend desktop app for Linux and macOS, what it shows, how to build it from source, and how it
  signs in to a server.
sidebar:
  order: 3
---

The desktop app (`apps/desktop`, Electron) shows the sessions on a Mend server as terminals, with a
project tree and an inbox beside them. It holds no terminals of its own. Every terminal it draws is
a session process on the server, reached over the same `/api/tty` socket the CLI and the phone use,
so the app and a `mend attach` elsewhere can show the same session at once.

There is no published release of the desktop app yet. Build it from source as described
[below](#build-it-from-source). The macOS builds are unsigned and have not been opened on a Mac.

## What it does

### Projects, sessions and shells

The left rail has two faces, a tree and an inbox. `Ctrl+Shift+B` switches between them, and the
choice persists.

- The **tree** lists projects, any number open at once. Each session opens into what runs in it: the
  agent, every live supporting shell, and its Services. `shell` sessions are listed too.
- The **inbox** is a flat list of agent sessions across projects, newest first. Activity does not
  reorder it. A session that finished since you last looked at it reads `done`; `input`, `working`
  and `failed` show what else needs attention. Settled sessions sit on a collapsed shelf below, and
  a Snoozed shelf holds sessions you set aside. Scoping the inbox to one project adds **Services**,
  **PRs** and **Files** views. PRs are read through the GitHub CLI on the Mend server.

Each project has a tab bar. A session tab shows the session's agent. A shell tab is a supporting
shell in the focused session's workspace: it sees the session's worktree, so what you do there
belongs to the same change. `+` or `Ctrl+Shift+T` opens a shell in the focused session. Closing a
shell tab asks before it stops the shell; **detach tab** removes only the view. Closing a session
tab, switching tabs, quitting the app or losing the network detaches without stopping anything.

### Starting a session

The launcher is the same composer the web app uses. Type the first message, pick the harness
(`claude`, `codex` or `opencode`), the model, and settings such as thinking, permissions and the
base branch, then start. Choices are remembered per project and harness. The default harness a
project starts on is set in **Settings → Workbench**.

For `claude` and `codex`, the composer's settings menu has **Runs as**: **Terminal** (the default)
or **Conversation**. A conversation session runs the agent in protocol mode (codex app-server,
claude stream-json). Its tab shows the conversation instead of a terminal: turns in order, what the
agent said and did in each, and requests for approval or answers. Whoever steers the session can
send turns, answer approvals (allow once, allow for the session, decline) and questions, and
interrupt the open turn. Anyone else can read it.

### Ended sessions replay

The app never attaches to an agent that has ended. Its session tab replays the recorded terminal
output read-only, with a scrubber whose ticks are the session's checkpoints. A toggle switches to
the conversation transcript, and the fact line says how the process ended, for example
`exited · observed`.

### Resume and handoff

A settled session offers **resume**, which rejoins it in the mode its agent last ran in. For a
`claude` or `codex` session whose agent ran, the session's owner also gets **continue as
conversation** or **continue in terminal**. That continues the same provider session in the other
mode. Handing off a live agent asks first, because its process ends.

### Review and landing

**review the change** in the session header opens the review in the app: the diff pinned to a pair
of checkpoints, line and change comments, and delivery of selected comments as a follow-up to the
same session. See [Review a change](/guides/review-a-change/).

Once a session has a change, the header shows **land** to the change's owner, or **landing** to
anyone else once Mend has pushed something. Both open the Land sheet: where the change goes, what
Mend observed, **Check origin**, **Refresh pull request**, a link to the pull request, and past
landings. The owner can push from there. A strip under the header states the latest landing fact.
For a conversation session, the composer's settings menu also carries **Land when a turn
completes**. See [Land a change](/guides/land-a-change/).

### Services

**Services** in the session header, or `Ctrl+Shift+S`, opens the Services sheet for the session. It
shows each Service's process, forward and target as observed, its recipe or one-off origin, and its
controls, and lets you start a recipe or a one-off command. Logs open in a sheet and can become a
tab. When the server is not this machine, a Service's port answers on the Mend host only, and the
sheet shows the `mend service connect <name>` command that tunnels it to your loopback. See
[Development services](/guides/services/).

When a stopped agent leaves Services running, the header says what keeps the workspace up and offers
**stop services**.

### Who can do what

Controls follow what the server says you may do. Only a caller who steers a session attaches to its
terminal; anyone else reads its record, and a line under the header says who steers. The session's
owner has the **Shared control** switch in the header. See
[Organizations](/organizations/overview/).

## Keyboard

The app listens for these keys even while a terminal has focus. They use `Ctrl+Shift` or
`Ctrl`+digit, so the shell and terminal programs never see them.

| Keys                          | Action                                                 |
| ----------------------------- | ------------------------------------------------------ |
| `Ctrl+Shift+J` / `K`          | Next / previous session (agents only, across projects) |
| `Ctrl+Shift+H` / `L`          | Previous / next project                                |
| `Ctrl+Shift+T`                | New shell in the focused session                       |
| `Ctrl+Shift+W`                | Close the focused tab (asks before stopping a shell)   |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab in the project                     |
| `Ctrl+1` … `Ctrl+9`           | Jump to that inbox row                                 |
| `Ctrl+Shift+P`                | Command palette                                        |
| `Ctrl+Shift+B`                | Switch the rail between tree and inbox                 |
| `Ctrl+Shift+S`                | Services sheet                                         |
| `Ctrl+Shift+=` / `-` / `0`    | Terminal font bigger / smaller / reset                 |
| `Ctrl+,`                      | Settings                                               |
| `Alt+Space`                   | Bring the window forward from any app                  |

`Alt+Space` is a global shortcut. When another app already holds it, it does nothing.

## Settings

**Settings** (`Ctrl+,`) holds the terminal font family and size (6 to 32 px), the theme (system,
light or dark; the terminal stays dark), the default harness, the connection, and your connected
provider accounts. Everything except the connected accounts is stored on this machine only.

## Connect to a server

The app reads and writes the same credential file as the CLI, `$XDG_CONFIG_HOME/mend/cli.json`
(`~/.config/mend/cli.json` by default). If you already ran `mend login` on this machine, the app is
signed in to that server. It watches the file, so a `mend login` or `mend logout` in a terminal
reaches the running app without a restart. `MEND_URL` and `MEND_TOKEN` override the file, as they do
for the CLI. With no URL anywhere, the app uses `http://localhost:3105`.

To sign in from the app, open **Connect to your Mend server**, enter the **Server URL**, and choose
**Sign in with the browser**. This is the same flow as `mend login`: your browser opens on the
server's approve page, you check that the code matches, and you approve. The app is then a device
named `<hostname> · desktop`, which you can revoke under **Settings → Devices** in the web app.
**Paste a token instead** accepts a bearer token directly.

Signing out revokes the device on the server, then removes the token and device id from the file.
The file's URL stays. While `MEND_TOKEN` supplies the token, signing out changes nothing and says
so.

Each terminal connection uses a single-use [upgrade ticket](/operate/exposure/) minted for it. The
app sends terminal sockets to the configured server without a browser `Origin` or cookie, so the
server treats them as a token client, as it does the CLI.

## Build it from source

You need a checkout of the repository with its toolchain: Node (the repository pins 26.4.0 in
`.node-version`) and pnpm.

```sh
git clone https://github.com/sealant-sh/Mend.git
cd Mend
pnpm install
```

Run the app against your server without packaging it:

```sh
pnpm -F @mend/desktop dev
```

Or package it. `package` builds the app, then runs electron-builder for the host platform. Append
`--linux` or `--mac` to pick one.

```sh
pnpm -F @mend/desktop package
pnpm -F @mend/desktop package --linux
pnpm -F @mend/desktop package --mac
```

The artifacts land in `apps/desktop/release/`, named `Mend-<version>-<os>-<arch>.<ext>`:

| Platform | Targets                              |
| -------- | ------------------------------------ |
| Linux    | AppImage and `.tar.gz`               |
| macOS    | `.dmg` and `.zip`, for arm64 and x64 |

On Linux the executable is `mend-desktop`. On a Linux host the macOS `.zip` builds, but the `.dmg`
needs a macOS machine.

The macOS builds are not signed or notarized, so Gatekeeper refuses a downloaded copy, usually as
"damaged". Clear the quarantine flag after copying the app to `/Applications`:

```sh
xattr -dr com.apple.quarantine /Applications/Mend.app
```

On Linux the app pins the display scale to 1 to avoid oversized windows on some Wayland compositors.
Set `MEND_DEVICE_SCALE` to another number to pin a different scale, or to `auto` to let the
compositor decide.
