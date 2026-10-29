---
title: Phone
description:
  Run the Mend phone app in a phone's browser, pair it with your server, and steer sessions and
  review changes from it.
sidebar:
  order: 5
---

The phone app (`apps/mobile`, an Expo app) lists your sessions, opens a session's conversation,
sends turns, and reviews the change with comments that go back to the session. It talks to a Mend
server over its HTTP API with a token of its own.

In 0.36 the app is not published: there is no App Store or Google Play build, and the Mend server
does not serve it. `mend pair` says so:
`the app is apps/mobile — build it yourself; it is not published yet`. What runs in a phone's
browser is its web build, from a checkout of the Mend repository.

## Open it

From a checkout with dependencies installed (`pnpm install`), on a machine the phone can reach:

```sh
pnpm --filter @mend/mobile web
```

This runs `expo start --web`, which serves the web build on port 8081 by default. Open
`http://<that machine's address>:8081` in the phone's browser; the port must be reachable from the
phone. Alternatively, `npx expo export --platform web` (run in `apps/mobile`) writes a static build
to `dist/`, one HTML file per route, for any static file server you run.

The phone then has to reach two things: the web build, and the Mend server it pairs with. See
[Work from another device](/guides/remote-access/) for reaching the server. The server answers
browser calls only from origins it was told about, so add the web build's exact origin:

```sh
mend server setup --origin http://<that machine's address>:8081
```

The list given replaces the saved one, so repeat any origin already configured. Without it, the
server refuses the app's requests (`Origin not allowed`).

## Pair it

1. On the machine, open the web app's **Settings → Devices** and choose **Pair a phone**, or run
   `mend pair`. Either shows a code, the server URL, and a QR. A code is good for one device, once,
   for ten minutes.
2. In the phone app, choose **Pair with your machine** (on Now, or under Settings). The browser
   cannot scan a QR (`the camera rides the native app — type the code below`), so choose **Type the
   code instead**.
3. Enter the **Server URL** shown beside the code and the **Pairing code** (`ABCD-EFGH`), then
   **Pair**.

The server mints a token for the phone and lists the device under Settings → Devices, where you
revoke it. The web build keeps the token in the browser's storage. **Unpair** in the app's Settings
clears it on the phone, asks the machine to stop sending the phone notifications, and clears the
ones already delivered; the device stays listed until you revoke it. Pairing with another machine
does the same for the last one. Settings → **Advanced** takes a server URL and bearer token typed by
hand instead, such as one from **Mint a token by hand** in the web app.

## What it does

- **Now** lists sessions under `Needs you`, `Live` and `Recently settled`. A row names its harness:
  `Claude Code`, `Codex`, `OpenCode`, and any other by its id, such as `pi` or `shell`.
- **Projects** starts a `claude` or `codex` conversation in an adopted project, with a worktree
  name, model, thinking effort and base. The first turn goes through the composer.
- A session opens as its conversation. Send a turn in `Message the session…`, stop the open turn,
  answer approvals (`Allow once`, `Allow for session`, `Decline`) and questions, and attach images.
  Header actions include `Resume`, `Deliver follow-up`, `Review the change` and `Diff`; the rest sit
  under `More actions`, and `Stop session` is only ever there.
- A Claude workflow shows as a card on the turn that started it while it runs: each phase, each
  agent's state, model, tokens and current tool, and the totals. The turn Claude starts to report it
  reads `the agent continued · …`.
- **Review the change** shows the diff with `Suggest fixes`, `Read this change` and the change's
  description and tour. Tap a line to comment on it, or comment on the change as a whole, then
  `Send review` sends the comments to the session as one instruction you can edit first. If the
  agent is still working, it is saved as a follow-up for `Deliver follow-up`.
- Once a change is landed, its pull request shows as a card in the conversation, the review and the
  session row, with `Open on GitHub`, and `Refresh` for the change's owner. Read
  [where the pull request shows](/guides/land-a-change/#where-the-pull-request-shows).

## What it does not do

- It does not land a change. Land from the web app or the CLI; the phone shows the result.
- It starts only `claude` and `codex` sessions, as conversations. It does not start `opencode` or
  `pi`, and does not attach to a terminal agent; a terminal session shows its transcript.
- In the browser, several native parts are missing. The shell reads
  `React Native WebView does not support this platform.`, and push notifications answer
  `unavailable`.
- LaTeX in assistant replies shows as its source in the browser.
