---
title: Known issues
description:
  Limits of the current release that change what you see or what Mend keeps, and what Mend does
  about each.
sidebar:
  order: 2
---

Each entry says what happens, where, and what Mend does meanwhile. None of them deletes work on its
own: where Mend cannot confirm a save, it keeps the executor.

## A Stop on Garage can wait for its seal

Applies to buckets that ignore conditional writes (`If-None-Match`). Garage, the bucket
`mend server setup` installs, is one.

On such a bucket an upload link Mend handed out could replace an object until it expires, so Mend
does not accept a final save (its seal) while one could. An executor whose sealantd binds each
upload link to the bytes it was minted for has none of those links: Garage refuses any other bytes
through them, so a Stop waits for no link. Mend still reads the save back before it accepts it. It
skips what it has already read and verified since the last link that could have changed anything.
After Mend restarts, the first Stop of each session reads everything that session's save names once.
The wait for links remains:

- for an executor whose sealantd predates bound links, until its links expire plus a 5-minute margin
  for the bucket's clock: about 10.5 minutes after a small Stop, up to 20 after a large one;
- for a seal that carries what such an executor saved, until that executor's links have expired;
- for a Stop that uploaded a single object over 5 GB, which goes up in parts.

A restart of Mend no longer holds a Stop. Before 0.36 every Stop in the 20 minutes after a start
waited those 20 minutes out. The upgrade to 0.36 itself still does, once: for 20 minutes after the
first start on 0.36, a Stop waits as it did before.

Meanwhile the session stays `stopping` and says `final seal not confirmed`, and the executor keeps
running. Nothing is lost: the session finishes stopping once the seal stands.

AWS S3, Cloudflare R2 and MinIO refuse a conditional overwrite, and a Stop there has no such wait.
Only AWS MicroVM executors have a time limit, and they use S3. Docker and Kubernetes executors have
no time limit.

## Sessions cannot start on Ubuntu 23.10 and later until user namespaces are allowed

Each workspace runs its own rootless Docker, which Ubuntu's default AppArmor setting refuses. Mend
does not change a host's kernel settings for you: `mend server setup` and `mend doctor` say what to
run. See
[Every session fails to launch on Ubuntu](/operate/troubleshooting/#every-session-fails-to-launch-on-ubuntu).

## SHA-256 repositories are not supported

Mend refuses to adopt a repository that uses SHA-256 object names:

```text
Mend doesn't support SHA-256 repositories yet.
```

A project adopted before this check is refused the same way when a session starts on it.

Converting a session's repository to SHA-256 while the session runs is not supported. Its later
saves never seal, so a Stop never finishes: the executor is kept and the session stays `stopping`.
Discard unsaved and stop is the only way to end it, and it discards what the executor holds.

## Build output carried from another platform is checked at its top level

A session that moves between an arm64 and an amd64 executor carries the other platform's dependency
tree (for example `node_modules`) along. Before a seal stands, Mend reads each carried tree back.
For trees in the older one-object-per-directory format (`MEND_CAPTURE_MANIFEST_FORMAT=1`, or
captured before dir packs), that read covers the top-level directory and the file contents, not
every nested directory. The default format is read back in full.

## An edited copy of Mend's old workspace note stays in the memory file

Before this release, Mend's note in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` started at a
`<!-- mend:mounts -->` line and ran to the end of the file. The first launch after the upgrade turns
that note into the new bounded block when every line of it is exactly what Mend wrote, and keeps
whatever follows it. If someone edited inside the old note, Mend removes none of it: the old note
stays where it is and the new block is added at the end. The agent then reads both. Delete the old
note by hand.

## Setup commands run on a worktree's first launch only

A resume does not run a custom image's setup commands again: the saved capture it restores already
holds what they produced. Run them yourself if a lockfile changed. The session says
`setup skipped · restored from capture <n>` when it starts. Anything setup installed outside the
worktree is not in the capture; put it in Extra packages or the image. See
[When setup commands run](/guides/workspace-images/#when-setup-commands-run).

## A machine failure loses the last few seconds

A Stop, a replacement or a resume keeps everything. So does an executor killed outright whose disk
survives: the platform keeps it and boots it again to save what it holds. An executor whose machine
fails without warning can lose what was written after its last capture. Captures run 2 seconds after
the files go quiet, and at least every 10 seconds while they keep changing.

## opencode does not really work yet

opencode sessions start, but little else about them is finished. Treat opencode as unsupported for
now.

## pi runs in the terminal only

pi sessions run as terminals: attach from the CLI, the web app, the desktop app or VS Code. The
phone and Slack cannot start or steer them yet; that needs the structured mode Claude Code and Codex
have.

## pi packages that build native code need build tools

A pi package that compiles native code when it installs needs `make`, a C compiler and Python.
Workspace images do not include them, so such a package (`@plannotator/pi-extension` is one) fails
to install. The session leaves it out, says so in the terminal, and pi starts without it: pi itself
would stop at startup. Add the build tools to the project's
[workspace image](/guides/workspace-images/) to install it.

A package that failed is tried again at every launch, which adds a few seconds.

## Each new pi session installs its packages again

A session's harness home is its own, so every new pi session installs the packages and extension
dependencies of your [pi profile](/guides/pi/) again: about a minute the first time, a few seconds
when the same session launches again. Agent memory is the only thing carried between sessions.

## Your pi profile is the same in every project

`mend connect pi` saves one profile per person, delivered to every pi session you start, in any
project. A project's own `.pi/settings.json` in the repository still applies on top of it, as it
does on your machine.

A session that is already running keeps the profile it started with.

## Agent memory is saved when the agent ends

Mend reads back what the agent learned when its agent ends: on a Stop, when the agent exits, or when
a session is handed to another mode. A conversation that stays open for days saves its memory then,
not before, so a session started meanwhile does not see what that one has learned yet. See
[Agent memory](/guides/agent-memory/).

When two of your sessions changed the same memory file, both sides' lines are kept, so a line both
of them wrote can appear twice. The agent tidies its memory as it goes.

## A session that joins someone else's executor uses their memory

On a server, a worktree has one executor. A session you start in a worktree where another person's
session is already running joins their executor, and its agent shares their harness home. It reads
their memory, not yours. What it learns there is saved to their memory, not yours: when their agent
ends, when they next work in that worktree, or when someone else next starts there. Start your
session in a worktree of your own to work from your memory.

A session started in a worktree someone else used before you, once their executor has ended, starts
from your memory. Theirs is saved for them first and moved aside in `.mend/agent-memory-kept/`. An
executor started before this release is still judged by who started it until it ends: if someone
started it after another person had used the worktree, their sessions there can still save that
person's earlier memory as their own.

## Codex memory builds slowly, and on your login

Codex makes memory from a conversation only once it has been quiet for six hours, and only two at
each session start, with model calls on your own login. Mend carries your earlier Codex
conversations on the project into each new session so it can, a few at a time. A session resumed
later learns only from what was carried at its first launch. pi and opencode keep no memory of their
own.

Everything else in a session's harness home stays with that session: its conversations, and settings
or plugins changed inside it. A conversation resumes in its own session, not from another.

## Importing brings memory, not conversations

`mend memory import` brings the memory Claude Code keeps for the checkout on your machine. Your past
conversations are not imported: a conversation needs its paths rewritten to resume in a session.
`mend adopt` says when there is memory to import; it does not import it itself.

## Agent memory is in the CLI only

`mend memory`, `mend memory show` and `mend memory rm` list, print and remove your memory for a
project. The web app and the phone do not show it yet.
