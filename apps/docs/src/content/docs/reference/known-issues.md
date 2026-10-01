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
through them, and a Stop seals as soon as its save is verified. The wait remains:

- for an executor whose sealantd predates bound links, until its links expire plus a 5-minute margin
  for the bucket's clock: about 10.5 minutes after a small Stop, up to 20 after a large one;
- for a seal that carries what such an executor saved, until that executor's links have expired;
- for a Stop that uploaded an object of 16 MB or more, which goes up in parts, or a new commit's
  pack index in the first 20 minutes after Mend started: those links are not bound;
- for 20 minutes after Mend restarts.

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
