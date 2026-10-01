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

## A Stop on Garage waits about 10 minutes for its seal

Applies to buckets that ignore conditional writes (`If-None-Match`). Garage, the bucket
`mend server setup` installs, is one.

On such a bucket, an upload link Mend handed out can still replace an object until it expires. Mend
does not accept a final save (its seal) until every upload link of that session's executor has
expired, plus a 5-minute margin for the bucket's clock. A Stop that uploaded a few megabytes waits
about 10.5 minutes. A Stop right after a large upload waits up to 20 minutes. In the first 15
minutes after Mend restarts, every seal waits until those 15 minutes are over.

Meanwhile the session stays `stopping` and says `final seal not confirmed`, and the executor keeps
running. Nothing is lost: the session finishes stopping once the seal stands.

AWS S3, Cloudflare R2 and MinIO refuse a conditional overwrite, and a Stop there has no such wait.
Only AWS MicroVM executors have a time limit, and they use S3. Docker and Kubernetes executors have
no time limit.

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
