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

## opencode runs in the terminal only

opencode sessions run as terminals, as pi sessions do: attach from the CLI, the web app, the desktop
app or VS Code. The phone and Slack cannot start or steer them. opencode keeps its conversations in
a database rather than a file. A stopped opencode session resumes on the conversation it started
(`opencode --session <id>`), which Mend reads out of that database when the session stops, but Mend
shows no transcript for it and cannot resume it on another harness. Two opencode sessions running at
the same time in one worktree can leave Mend unable to tell whose a conversation is; resuming either
is then refused rather than opening the wrong one. opencode has no shared effort scale, so
`--effort` does not apply to it.

When a repository has a `.opencode` directory, opencode installs its own plugin package there at
startup, and a lockfile committed in it can change. That edit shows up in the session's change like
any other.

opencode's database is saved with the session as its conversation, and in a remote workspace the
next session in the worktree, anyone's, opens it. A login you make inside opencode to the opencode
console or to one of its integrations is kept in that database, so it travels with it. The logins
Mend gives opencode (your ChatGPT login) never go there. Sign in to the console or integrations only
in a worktree nobody else uses.

In a remote workspace, opencode keeps the logins of the MCP servers it signs in to in a file Mend
keeps out of what the session saves, when Mend starts opencode:

- An MCP sign-in lasts only as long as that workspace. Resuming the session on a new workspace asks
  for it again.
- People joined on one workspace share that file. One person's opencode uses MCP sign-ins the other
  made there.
- An opencode you start by hand in a session's shell writes that file into saved state until the
  platform leaves it out too (sealantd#136). The next session in the worktree then removes it unread
  before it starts, but the earlier saved states still hold it.
- A session saved before this change may hold MCP sign-ins; every later session in the worktree
  removes them unread before it starts, and removes a link left at that file's place that leads
  anywhere else.

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
their memory, not yours, and what it learns there is saved to their memory, never to yours:

- what it writes before their agent ends is saved when that agent ends;
- what it writes after that is saved when their next agent in that worktree ends, or when someone
  else next starts a session there.

A joined Codex session starts with its memory off: it neither builds memory nor leaves conversations
for anyone's Codex to build memory from, yours included, later or anywhere else. A session that
joins while the other person's session is still starting can begin before Mend has moved the
previous person's memory out of the way: its agent can read that memory, and what it writes there
ends up kept beside it. Start your session in a worktree of your own to work from your memory.

## A worktree someone else used before you

A session you start in a worktree someone else used, once their executor has ended, starts from your
memory. Mend first saves theirs for them, then moves it to `~/.mend/agent-memory-kept/` in that
worktree's executors, where it stays: anyone working in the worktree, and their agent, can read it
there. Nothing deletes these kept sets, so in a worktree people take turns in they add up, one copy
of the previous person's memory per turn, and every later session restores them. When Mend cannot
tell whose memory the worktree held (it was used before this release by several people, or their
sessions were removed), nobody is credited and it is only moved.

An executor started before this release is judged by who started it until it ends.

## A `codex` you run yourself in a shared worktree

Your Codex sessions on a server never build memory from another person's conversations. A `codex`
you type in a shell session, or one your agent runs in a Claude, opencode or pi session, is not a
Codex session: Mend does not prepare it, and it can build memory from the other conversations in the
worktree into the memory that worktree's home holds. Start a Codex session instead.

The same goes for a Codex session whose command Mend does not recognise as `codex`: one wrapped in
`env`, started by an absolute path or through `npx`, or run from a shell script
(`mend run -- sh -c "…"`). Joining someone else's executor, it starts with Codex's own memory
settings, so the conversations it starts can build their memory.

Two smaller gaps in the same place:

- Codex can turn a withheld conversation back on itself when it reconciles an older conversation's
  file (the resume picker's search does), for conversations recorded before Codex 0.160. Those age
  out of what Codex builds memory from ten days after their last change.
- Conversations you start inside Codex with `/new` are not known to Mend as yours, so your next
  Codex session withholds them too: they do not build your memory.

## Codex memory builds slowly, and on your login

Codex makes memory from a conversation only once it has been quiet for six hours, and only two at a
time when a session or a turn starts, with model calls on your own login. Mend carries your earlier
Codex conversations on the project into each new session so it can, a few at a time. A session
resumed later learns only from what was carried at its first launch. pi and opencode keep no memory
of their own.

Everything else in a session's harness home stays with that session: its conversations, and settings
or plugins changed inside it. A conversation resumes in its own session, not from another.

## Importing brings memory, not conversations

`mend memory import` brings the memory Claude Code keeps for the checkout on your machine. Your past
conversations are not imported: a conversation needs its paths rewritten to resume in a session.
`mend adopt` says when there is memory to import; it does not import it itself.

## Agent memory is in the CLI only

`mend memory`, `mend memory show` and `mend memory rm` list, print and remove your memory for a
project. The web app and the phone do not show it yet.
