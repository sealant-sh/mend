---
title: Desktop app
description:
  The Mend desktop app for Linux and macOS, what it shows, how to build it from source, and how it
  signs in to a server.
sidebar:
  order: 3
---

The desktop app (`apps/desktop`, Electron) is a window around the Mend web app. It loads your
server's web app directly, so everything in it is the web app: the sidebar inbox, projects, a
session's workspace with its tabs and tiles, the change, and Settings. It has no screens of its own
beyond choosing a server and saying when the server does not answer.

The desktop app is not part of the 0.36 release. There is no published build, and the release's
checks do not cover it. The clients 0.36 publishes are the CLI and its dashboard, the web app and
the [VS Code extension](/clients/vscode/). This page describes the source on `main`. Build it from
source as described [below](#build-it-from-source). The macOS builds are unsigned and have not been
opened on a Mac.

## What it adds to the web app

- **A server picker.** With no server chosen yet, or after **Switch Server…**, the window shows
  **Server address**, **Connect**, and up to six **Recent servers**. It suggests the server your CLI
  uses: `MEND_URL`, or else the URL in `$XDG_CONFIG_HOME/mend/cli.json`.
- **An offline screen.** When the server does not answer, the window says so, keeps trying, and
  reloads the web app as soon as the server answers. **Try again** checks at once.
- **A badge.** The app's icon counts the sessions waiting on you.
- **Links leave the window.** A page on another origin, and any link that opens a new window, opens
  in your browser instead.

## Menu and keys

| Keys                      | Action                                         |
| ------------------------- | ---------------------------------------------- |
| `Ctrl+N`                  | New session                                    |
| `Ctrl+,`                  | The web app's Settings                         |
| `Ctrl+Shift+O`            | Switch Server…                                 |
| `Ctrl+W`                  | Close the focused tab in a session's workspace |
| `Ctrl+Shift+W`            | Close the window                               |
| `Ctrl+R` / `Ctrl+Shift+R` | Reload / reload without the cache              |
| `Ctrl+0`                  | Actual size                                    |
| `Alt+Space`               | Bring the window forward from any app          |

On macOS, `Cmd` takes the place of `Ctrl`. `Alt+Space` is a global shortcut. When another app
already holds it, it does nothing.

## Connect to a server

Enter the server's address and choose **Connect**. The app checks that a Mend server answers there,
then loads its web app, where you sign in as you would in a browser. The app keeps only the server's
address, the recent servers and the window's size; your sign-in lives in the window's cookies, as it
does in a browser.

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
