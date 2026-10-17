---
title: t3code
description:
  Use t3code's desktop, mobile or web client with Mend. The t3code gateway shows Mend's projects and
  sessions as t3code projects and threads, as the person who paired.
sidebar:
  order: 2
---

[t3code](https://github.com/pingdotgg/t3code) is a client for coding agents. With the t3code gateway
turned on, its desktop, mobile and web clients add your Mend server as a remote environment. Your
projects are t3code projects and your Codex and Claude sessions are threads: you start a thread in a
new or an existing worktree, send messages and images, answer the agent's approvals, read each
turn's diff, and open a terminal, from t3code. Only sessions whose agent Mend runs over its protocol
show as threads; PTY sessions (`mend codex`, `mend claude` in a terminal), shell sessions and other
harnesses do not.

The gateway supports t3code's core workflow; more of t3code is coming in 0.36 patch releases.

Mend stays the only source of truth. To t3code the gateway is a t3code server; to Mend it is an
ordinary client, calling Mend's API with the device token of the person who paired. Everything a
thread does goes through Mend's own routes and its rules: a session started from t3code is yours,
runs as you, and shows in Mend's web app, CLI and Slack like any other.

## Turn it on

The gateway is off unless you turn it on. On a server installed with `mend server setup`, run it
again and answer yes to "Turn on the T3 Code gateway?" (choose "change something", then "the T3 Code
gateway"). The flag does the same, and keeps everything else as saved:

```sh
mend server setup --t3-gateway
```

It runs in the Mend container on a listener of its own, port `3120`, published on the same address
as Mend's web port ([Where it is reached](#where-it-is-reached)). `--t3-gateway-port <n>` picks
another port. The choice is kept across reruns and upgrades. Setup refuses it on a Mend version
whose image has no gateway, and says whether the gateway answered once Mend was up (it looks for
about a minute). It also refuses a gateway port something on the machine already holds, Mend's own
`--port` or `--ssh-port`, and 80 or 443 when the edge has them. `mend server setup --no-t3-gateway`
turns it off; its state stays in its own volume, `mend_mend-t3-gateway`, and comes back if you turn
it on again. `mend uninstall` removes that volume too.

`mend server status` says where it is published, and whether this machine reached it there. On a
server reached over Tailscale:

```text
t3code gateway · on · published on 100.70.80.90:3120, where Mend's web port is · T3 Code's Remote link takes http://mend-box.tail1234.ts.net:3120
t3code gateway · observed answering at 100.70.80.90:3120 from this machine · T3 Code's Remote link takes http://mend-box.tail1234.ts.net:3120
```

`mend doctor`, from any machine signed in to the server, shows the same address on its
`t3code gateway` line.

From a checkout, run it beside a Mend server instead:

```sh
MEND_T3_GATEWAY_MEND_URL=http://127.0.0.1:3101 pnpm --filter @mend/t3-gateway start
```

`MEND_T3_GATEWAY_PORT` (default `3120`) and `MEND_T3_GATEWAY_HOST` (default `127.0.0.1`) set where
it listens, `MEND_T3_GATEWAY_STATE_PATH` its state file (default
`~/.local/state/mend/t3-gateway/state.sqlite`, under `$XDG_STATE_HOME` when set), and
`MEND_T3_GATEWAY_LABEL` the environment's name in t3code (default `Mend`, which a packaged server
uses).

## Pair a t3code client

The gateway speaks t3code's orchestration protocol 2, built against the t3code preview
`v0.1.1-preview.20261017.3254`. Use a client of that preview; one of the previous pin,
`v0.0.46-nightly.20261010.2922`, still pairs and works. A protocol-1 client, such as the stable
`v0.0.45`, is refused when it connects. A later nightly that still speaks protocol 2 may have
changed what it sends: the gateway follows newer clients only when its pinned contracts are moved to
them, deliberately.

1. Run `mend pair`. It prints a pairing code, good for one device for ten minutes, and the gateway's
   address:

   ```text
   ✓ pairing code ABCD-EFGH
     url     http://mend-box.tail1234.ts.net:3105
     expires in 10 min · one device, once
     t3 code http://mend-box.tail1234.ts.net:3120
             in T3 Code, add a Remote link with this address and the code, or paste http://mend-box.tail1234.ts.net:3120/pair#token=ABCDEFGH
   ```

2. In T3 Code, add an environment with **Remote link**: enter that address (with its `http://`; T3
   Code reads a bare host as `https://`) and the code, or paste the link that carries both.

Use Remote link, not T3 Code's **SSH** mode. SSH mode installs and starts T3 Code's own server on
the remote machine and talks to that, not to Mend; nothing of Mend is in it.

Pairing claims the code through Mend, so Mend lists the client among your devices as
`t3code · <client>`. Revoking that device in Mend signs the client out of the gateway: within five
seconds for a new request or connect, and within 15 seconds for a socket it already holds. t3code
then shows the environment as failed ("The environment credential is invalid.") and stops
reconnecting; pair it again with a new code. A gateway that was not running when the device was
revoked finds it when it starts. While Mend cannot be reached, the gateway serves no new connection
or snapshot, since it cannot confirm the device; t3code retries until Mend answers.

A client of the previous pin keeps what its pairing could do. One granted only `orchestration:read`
by an older gateway no longer reads files, which now need a permission of their own: pair it again.

## Who you are in t3code

- Sessions you start from t3code are yours: Mend records you as their owner, and their agent runs as
  you, with your provider logins (see [Per-person workspaces](/operate/per-person-workspaces/)).
- t3code shows Claude and Codex as signed in when Mend holds an active `default` login of yours for
  them, the one your sessions use. It warns when Mend holds none, or one that is invalid, and says
  when Mend observed it expired or failing to refresh: connect one with `mend connect claude` or
  `mend connect codex`, and t3code shows the change without reconnecting.
- You see the projects Mend shows you, and of their sessions the Codex and Claude ones that run over
  Mend's protocol. You can send to a session only when Mend lets you steer it: your own, or one
  whose owner turned on shared control. Any other thread is read-only, and t3code says you are not
  authorized when you try.
- A message you send goes as you, with your device, under shared control too: in a per-person
  workspace your turn spends your own login, and in a workspace that shares one home, the owner's
  (see [Per-person workspaces](/operate/per-person-workspaces/)).
- Threads show Mend's own lines about a shared workspace, as its web app does: who else runs in it
  ("Shared workspace with Anna · each of you runs as yourself · either of you can read the other's
  files."), a turn that waits for the previous sender's work, and a workspace that started before
  Mend 0.36 and shares one home ("This workspace started before Mend 0.36 and shares one home · it
  takes only Anna's sessions and turns until it is replaced").
- Renaming and deleting a session, and opening a terminal in it, are its owner's, as in Mend.

## What t3code can do with Mend

| In t3code                          | What happens in Mend                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New thread in a new worktree       | A session in a new worktree from the base you chose, named from the branch's last segment and six random characters (`health-check-k3x9qa`), so two launches never share one, labelled with the thread's title or its first message's first line. It launches on the model, reasoning effort, service tier and runtime mode you chose                                                 |
| New thread in an existing worktree | A session that joins the worktree of the project's session at that path                                                                                                                                                                                                                                                                                                               |
| Send a message, with images        | A turn, sent as you once no turn is open. When the agent has stopped (the 15-minute idle stop, or a stop), the gateway launches it again on the permission mode it recorded, so a session that asks still asks, and sends the message once it runs. Images (PNG, JPEG, GIF or WebP, at most 8 MiB each and ten a message) are placed in the session's workspace and named in the turn |
| Queue, edit, reorder, resume       | The gateway's queue, kept across a restart of the gateway; a message is never sent twice. One that was being sent when the gateway stopped comes back failed, saying so. A message already on its way to Mend is not edited or moved                                                                                                                                                  |
| Interrupt                          | The turn is interrupted and what waits is held until you resume                                                                                                                                                                                                                                                                                                                       |
| Approvals and questions            | The agent's requests, answered in Mend. Mend has no "always": allowing always allows for this session. Dismissing a question answers it with cancel                                                                                                                                                                                                                                   |
| Runtime mode                       | Applies from the agent's next start: Mend sets the mode per launch. The thread says so until then                                                                                                                                                                                                                                                                                     |
| Model                              | Another model of the thread's provider, picked on a started thread, applies from the agent's next start in the same conversation, and the thread says so until then. A thread on the harness's own default cannot go back to it once it names a model                                                                                                                                 |
| Reasoning effort                   | Shown as the agent runs on it. A change on a started thread applies from the agent's next start, as the runtime mode does, and the thread says so until then                                                                                                                                                                                                                          |
| Read state                         | Your own, kept by the gateway: opening a thread marks it seen, so one that finished while you were away shows as done, and Mark unread brings that back. Every device you pair sees the same                                                                                                                                                                                          |
| Rename, stop, delete               | Mend's own routes. A delete keeps the worktree and its change, as Mend always does, and t3code does not offer to delete the worktree                                                                                                                                                                                                                                                  |
| Archive                            | Your own view, kept by the gateway: Mend has no archive. What was queued is held, not lost                                                                                                                                                                                                                                                                                            |
| Settle                             | Your own, kept by the gateway as the archive is: Mend has none, and others sharing the session do not see it. A settle is refused while a turn runs, a message waits or a question is open: settle once they are done                                                                                                                                                                 |
| Snooze                             | Your own as well. The thread wakes at the time you chose, or earlier when the agent asks for an approval or an answer, or a turn fails or completes. A snooze ends in the future, and is refused while a question is open or a message waits to be sent, which it would hide                                                                                                          |
| Diffs                              | Each turn's slice of the worktree's checkpoints, matched to the turn by session and time, and the whole thread's. The changes panel shows the thread's change, the worktree against its base, and a file opened there whole                                                                                                                                                           |
| Files and `@`-mentions             | The session's worktree as it stands: the file tree, reading a file, searching contents. The Files tab is read-only                                                                                                                                                                                                                                                                    |
| Branch status                      | The session's branch and its change against its base. The branch picker lists the project's branches, any of them a new worktree's base, and the thread's own                                                                                                                                                                                                                         |
| Terminal                           | Mend's own shell beside the agent, opened with a single-use ticket                                                                                                                                                                                                                                                                                                                    |

Some of t3code has no counterpart in Mend. The gateway does not grant the permissions behind it, so
t3code shows those controls inert with its own wording, or it refuses them with t3code's own error:

- **In a thread:** steering a running turn (Ctrl/⌘+Enter, or the steer follow-up setting; send the
  message to run after it instead), holding a message back to send later, runtime modes between
  asking and full access, switching the provider, changing the service tier once the thread has
  started (start a new thread on the other tier), plan mode, rollback and forks, and attachments
  other than images. Provider slash commands and skills are absent: `/` lists t3code's own commands
  only. `/feedback` is refused.
- **Projects and git:** adding, creating, cloning, importing, renaming and removing projects (adopt
  and edit them in Mend), a thread in the project's root (every Mend session has a worktree), open
  in editor, editing files, project actions, pull request views, publishing a repository, and git
  operations (commit, push, branches, removing a worktree). Landing a change stays in Mend
  ([Land a change](/guides/land-a-change/)).
- **The environment:** providers other than Codex and Claude, provider sign-in and setup, settings
  and keybinding changes, usage and limits, scheduled tasks (the page lists none), the in-app
  browser, devices (the device panel says Mend runs none), diagnostics and resource telemetry,
  storage cleanup, MCP apps and connecting an agent over MCP, T3 Connect, and updating the server:
  the gateway updates with Mend. Pairing and revoking are done in Mend, with `mend pair` and your
  devices.

## Limits worth knowing

- **Large diffs.** Mend renders the patches of at most 200 files, 8 MiB, within 20 seconds per turn.
  A larger turn's diff ends with `[truncated]`, the marker t3code's own server uses.
- **Files on a server that is not Linux.** Mend reads a worktree's files through the directory
  descriptors only Linux gives it, so it never follows a link out of the worktree. Elsewhere (macOS)
  it refuses to read files as the worktree stands; diffs and checkpoint reads still work. A packaged
  server runs Linux in its container, so this bites only a checkout on macOS.
- **Large files and searches.** A file read answers at most 1 MiB of the file, and a content search
  at most 500 matching lines.
- **Large trees.** Mend lists at most 20,000 files. In a larger tree a file past that cannot be
  found from the composer, and the search says it was cut.
- **Uncommitted changes.** Mend reports a branch's change against its base, committed or not, and
  has no read of what is uncommitted. t3code's branch toolbar shows the branch's changes and no
  uncommitted ones.
- **Shared worktrees.** Mend keeps checkpoints per worktree, not per turn. When other sessions work
  in the same worktree, a turn's diff can include what they changed while it ran, and the thread
  says so: "Other sessions work in this worktree too: a turn's changes can include theirs from while
  it ran."
- **Archive and the queue.** t3code's own server cancels a thread's queued messages on archive; the
  gateway holds them instead, so none is lost. Unarchive the thread and resume, or cancel them.
- **Settle, snooze and read state are per person.** They are kept by the gateway, not Mend, so
  Mend's web app, the CLI and other people's t3code clients do not show them. A message sent to a
  settled or snoozed thread brings it back, as on t3code's own server. A thread you never opened in
  t3code shows no unread mark until you do.
- **Service tier.** Mend takes a tier when an agent launches and records none. A thread started from
  t3code keeps the tier it asked for on every relaunch; one started elsewhere shows Standard, since
  Mend does not say which tier it started on.

## Where it is reached

The gateway follows the exposure Mend's web port has
([Exposure and the public gate](/operate/exposure/)). Every device pairs through Mend wherever it is
published, so who may use it does not change with where it listens.

- **Just this machine** (`--exposure loopback`, or Mend on `127.0.0.1`): the gateway is published on
  `127.0.0.1:3120`. T3 Code on the same machine uses `http://127.0.0.1:3120`.
- **Your private network or Tailscale** (`--exposure private`, Mend's web port on the tailnet or a
  LAN address): the gateway is published on that same address. T3 Code on any machine that reaches
  Mend reaches the gateway at the same name, on its own port: `http://<tailnet name>:3120`. No
  tunnel, and no port opened anywhere else.

  When Mend's web port stays on `127.0.0.1` and Tailscale Serve forwards an HTTPS name to it, the
  gateway is on `127.0.0.1` too. Forward it the same way, on its own port, and use that name:

  ```sh
  tailscale serve --bg --https=3120 http://127.0.0.1:3120
  ```

  T3 Code's Remote link then takes `https://<this machine>.<tailnet>.ts.net:3120`.

- **The public internet, with the edge** (`--exposure public`): the gateway's own port stays on
  `127.0.0.1`; setup never publishes it on a public address. The edge serves it over HTTPS on a host
  of its own, never under a path of Mend's: a T3 Code client always uses a server's root path. Name
  that host and point its DNS where the edge's own name points:

  ```sh
  mend server setup --t3-gateway-origin t3.mend.example.com
  ```

  Caddy gets its certificate once the name resolves to the server and ports 80 and 443 answer; setup
  says where it resolved. T3 Code's Remote link then takes `https://t3.mend.example.com`, which also
  works from T3 Code's hosted web app. `--no-t3-gateway-origin` stops the edge serving it.

  On a public install that is also on a tailnet, Tailscale Serve reaches the gateway from the
  tailnet, with or without an origin: `tailscale serve --bg --https=3120 http://127.0.0.1:3120`, and
  the Remote link takes `https://<this machine>.<tailnet>.ts.net:3120`. Without an origin or Serve,
  the gateway on a public install is reached from the server's own machine only.

From a checkout, the gateway listens on `127.0.0.1` unless `MEND_T3_GATEWAY_HOST` says otherwise.

While the gateway is enabled, `mend operator exposure` lists `t3code-gateway`. Published on
`127.0.0.1` it is observed and closed. Published on a private address, it stays open until you have
checked from each network that should not reach the port and named it in `MEND_EXPOSURE_DECLARED`
(setup's `--declare t3code-gateway`). Served by the edge, it stays open until you have checked its
origin's certificate from another network, and named it the same way.

## Its state

The gateway keeps one SQLite file of its own, in its own volume on a packaged server
(`mend-t3-gateway`, `/opt/mend-t3-gateway/state/state.sqlite` in the container): its environment id,
each paired client, the thread ids t3code gave, the queue, images attached to messages (one never
sent is let go of after seven days) and what each sent message carried, deleted sessions Mend still
keeps, each person's archived, settled and snoozed threads and when they last saw each, and the mode
and effort chosen for an agent's next start. Mend's database is never touched; losing the file loses
pairings and t3code-side ids, never Mend's records.

The file holds each paired person's Mend device token, which acts as that person until the device is
revoked: the gateway needs it to read Mend and send queued messages when no client is connected. It
is written with mode `0600`. Keep it out of backups others can read, and revoke a `t3code · …`
device in Mend to end its token.

On a packaged server the gateway runs confined, apart from the rest of the Mend container: in a root
of its own holding only node, its own files and that volume, as a user of its own (uid 10120) with
no capabilities, with only the settings it needs and none of Mend's database or platform secrets,
and within limits on memory, processes and files. Mend's store, configuration, SSH keys and the
Docker socket are not visible to it. It reaches Mend over HTTP, as the people who paired.
