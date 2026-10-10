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

Mend stays the only source of truth. To t3code the gateway is a t3code server; to Mend it is an
ordinary client, calling Mend's API with the device token of the person who paired. Everything a
thread does goes through Mend's own routes and its rules: a session started from t3code is yours,
runs as you, and shows in Mend's web app, CLI and Slack like any other.

## Turn it on

The gateway is off unless you turn it on. On a server installed with `mend server setup`:

```sh
mend server setup --t3-gateway
```

It runs in the Mend container on a listener of its own and is published on `127.0.0.1:3120` only.
`--t3-gateway-port <n>` picks another port. The choice is kept across reruns and upgrades.
`mend server setup --no-t3-gateway` turns it off; its state stays in the config volume and comes
back if you turn it on again.

`mend server status` says it is on, and whether this machine reached it:

```text
t3code gateway · on · 127.0.0.1:3120 · loopback only · reaching it from elsewhere is an exposure you declare
t3code gateway · observed answering at 127.0.0.1:3120 from this machine
```

From a checkout, run it beside a Mend server instead:

```sh
MEND_T3_GATEWAY_MEND_URL=http://127.0.0.1:3101 pnpm --filter @mend/t3-gateway start
```

## Pair a t3code client

The gateway speaks t3code's orchestration protocol 2, built against the t3code nightly
`v0.0.46-nightly.20261003.2623`. Use a client of that nightly. A protocol-1 client, such as the
stable `v0.0.45`, is refused when it connects. A later nightly that still speaks protocol 2 may have
changed what it sends: the gateway follows newer clients only when its pinned contracts are moved to
them, deliberately.

1. Run `mend pair`. It prints a pairing code, good for one device for ten minutes.
2. In t3code, add a remote environment at the gateway's address, `http://127.0.0.1:3120` on the
   server's own machine, and enter the code.

Pairing claims the code through Mend, so Mend lists the client among your devices as
`t3code · <client>`. Revoking that device in Mend signs the client out of the gateway.

## Who you are in t3code

- Sessions you start from t3code are yours: Mend records you as their owner, and their agent runs as
  you, with your provider logins (see [Per-person workspaces](/operate/per-person-workspaces/)).
- You see the projects Mend shows you, and of their sessions the Codex and Claude ones that run over
  Mend's protocol. You can send to a session only when Mend lets you steer it: your own, or one
  whose owner turned on shared control. Any other thread is read-only, and t3code says you are not
  authorized when you try.
- Renaming and deleting a session, and opening a terminal in it, are its owner's, as in Mend.

## What t3code can do with Mend

| In t3code                          | What happens in Mend                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New thread in a new worktree       | A session in a new worktree from the base you chose, named from the branch (`-2`, `-3`, … when taken), labelled with the thread's title or its first message's first line |
| New thread in an existing worktree | A session that joins the worktree of the project's session at that path                                                                                                   |
| Send a message, with images        | A turn, sent as you once no turn is open. Images are placed in the session's workspace and named in the turn                                                              |
| Queue, edit, reorder, resume       | The gateway's queue, kept across a restart of the gateway; a message is never sent twice                                                                                  |
| Interrupt                          | The turn is interrupted and what waits is held until you resume                                                                                                           |
| Approvals and questions            | The agent's requests, answered in Mend                                                                                                                                    |
| Runtime mode                       | Applies from the agent's next start: Mend sets the mode per launch. The thread says so until then                                                                         |
| Rename, stop, delete               | Mend's own routes. A delete keeps the worktree and its change, as Mend always does                                                                                        |
| Archive                            | Your own view, kept by the gateway: Mend has no archive. What was queued is held, not lost                                                                                |
| Diffs                              | Each turn's slice of the worktree's checkpoints, matched to the turn by session and time, and the whole thread's                                                          |
| Files and `@`-mentions             | The session's worktree as it stands: the file tree, reading a file, searching contents                                                                                    |
| Branch status                      | The session's branch and its change against its base                                                                                                                      |
| Terminal                           | Mend's own shell beside the agent, opened with a single-use ticket                                                                                                        |

Some of t3code has no counterpart in Mend and is refused with t3code's own error: pull request
views, git operations (commit, push, branches), switching a thread's model or provider, plan mode,
rollback and forks, a thread in the project's root (every Mend session has a worktree), providers
other than Codex and Claude, and provider or settings changes. Landing a change stays in Mend
([Land a change](/guides/land-a-change/)).

## Limits worth knowing

- **Large diffs.** Mend renders the patches of at most 200 files, 8 MiB, within 20 seconds per turn.
  A larger turn's diff ends with `[truncated]`, the marker t3code's own server uses.
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

## Reaching it from another machine

On a server installed with `mend server setup`, the gateway listens on every address inside the Mend
container, and the host publishes its port on `127.0.0.1` only. From a checkout it listens on
`127.0.0.1` unless `MEND_T3_GATEWAY_HOST` says otherwise. A client on another machine needs
something in front of it that you choose and run: a tunnel, a reverse proxy, or a port on a network
you control. That is an exposure of its own ([Exposure and the public gate](/operate/exposure/)):
while the gateway runs, `mend operator exposure` lists `t3code-gateway`, open until you have checked
from another machine who reaches its port and named it in `MEND_EXPOSURE_DECLARED`.

## Its state

The gateway keeps one SQLite file of its own, in the config volume on a packaged server
(`/var/lib/mend/config/t3-gateway/state.sqlite`): its environment id, each paired client, the thread
ids t3code gave, the queue, images attached to messages, and archive flags. Mend's database is never
touched; losing the file loses pairings and t3code-side ids, never Mend's records.

The file holds each paired person's Mend device token, which acts as that person until the device is
revoked: the gateway needs it to read Mend and send queued messages when no client is connected. It
is written with mode `0600`. Keep it out of backups others can read, and revoke a `t3code · …`
device in Mend to end its token.
