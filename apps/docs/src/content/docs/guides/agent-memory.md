---
title: Agent memory
description:
  What Claude Code learns about a repository in one of your sessions, every later session of yours
  on the project knows.
sidebar:
  order: 10
---

Claude Code writes what it learns about a repository to its memory: a `MEMORY.md` index and the
notes it points to, which it reads at the start of every conversation. Mend keeps that memory **per
person per project**. Every session you start on a project receives your memory for it, and what the
agent learned is saved back when it ends. A session started on Monday knows what Friday's sessions
learned.

Your memory is yours. Other people's sessions on the same project never receive it, and yours never
receive theirs. On a server, a workspace that shares one home has exceptions: a session that joins
someone else's workspace uses their memory, and a turn someone steers under shared control writes
the owner's. See
[Known issues](/reference/known-issues/#a-session-that-joins-someone-elses-executor-uses-their-memory).
[Per-person workspaces](#per-person-workspaces) have none of those exceptions.

## Bring what your machine already knows

Claude Code on your laptop has probably learned about the repository already. From inside the
checkout:

```sh
mend memory import --dry-run   # show what the import would do, and write nothing
mend memory import             # import it
```

Only the memory is read: never transcripts, logins or settings. Mend combines your machine's memory
with its own, and the output names each file and what happened to it:

- **added**: a file Mend did not have.
- **merged**: a file both sides have with other contents. Both sides' lines are kept, each line the
  two share once. A line both sides wrote at different places stays twice. A note's frontmatter is
  merged key by key. Where the two give a key different values, Mend's value stays and your
  machine's is kept under it as a comment (`# from <host>, <date>: description: …`), which the agent
  reads and can fold in. If the result does not hold every line your machine sent, the output says
  how many, and your machine's file is kept as a version.
- **updated**: a file Mend has not changed since your last import from this checkout, which your
  machine has. Your machine's replaces it.
- **kept**: a file Mend changed since your last import, and your machine did not.
- **not added**: a file Mend removed since your last import, and your machine did not change.
- **conflict**: a file both sides changed that Mend does not merge: not text (an image), frontmatter
  that differs beyond plain `key: value` lines and comments, or two files too different to line up
  with no earlier import. Mend's stays, your machine's is kept as a version, and the next import
  names it again.

Mend remembers what it imported from each checkout on each machine, so the next import from there
merges against it: only what both sides changed since is merged. A second laptop starts with no
earlier import, and its first import keeps both sides' lines. A file Mend has and your machine no
longer has stays in Mend. Every version an import replaces is kept on the server.

`mend adopt`, run inside a checkout, says how many memory files Claude keeps for it on your machine.

## See and remove it

```sh
mend memory                    # your memory for the project in this directory
mend memory show MEMORY.md     # print one file
mend memory rm notes.md        # remove one
```

Each takes `--project <name>` from outside the checkout. A removed file is not delivered to the next
session, and a running session that still holds it unchanged moves it aside at its next launch. The
server keeps its last version.

## How it moves

- **At launch**, Mend writes your stored memory into the session's harness home, at the place Claude
  Code reads it. A file the session changed and Mend has not read back yet is left as the session
  has it.
- **When the agent ends**, Mend reads the memory back. Each file the session added or changed is
  saved; a file the session deleted is deleted, unless another session saved a newer one meanwhile.
- **When two sessions changed the same file**, the lines both added are kept. Every version Mend
  replaces or deletes is kept on the server, the last twenty per file.

A conversation that stays open for days saves its memory when it ends, not before.

## Per-person workspaces

In a [per-person workspace](/operate/per-person-workspaces/) each person runs as their own Linux
user, and memory follows the person a process runs as:

- **Delivered per person.** Each of your processes receives your memory in your own home, joins
  included. Someone else's process in the same workspace receives theirs.
- **Read back per process.** When a process ends, Mend reads back the memory it wrote for the person
  it ran as, and for nobody else. Codex builds memory only from your own conversations.
- **A once-shared session credits nobody.** From the moment shared control is turned on, the agent
  runs with no one's personal memory or instructions, only the project's, and nothing it writes is
  read back into anyone's memory. That holds after shared control is turned off, until the session
  ends (it is archived or deleted; a Stop does not end it). Start a new session to work from your
  memory again.

With `sudo`, anyone working in the workspace can still read your memory files there. See
[What sudo means here](/operate/per-person-workspaces/#what-sudo-means-here).

### Memory from before 0.36

A worktree that ran with one shared home before it first ran per person has that home's memory in
its captures. Mend credits it on the server, never during a launch, to:

1. the person Mend's record for that home names, when that record is settled (no hand-over to
   someone else waiting to be saved) and is for the workspace that wrote the reading;
2. else, when every session the worktree ever had was one person's, that person. Mend keeps who had
   sessions in a worktree even after a session is deleted, but only from 0.36 on: for an older
   worktree it cannot know, and this rule credits nobody;
3. else nobody. The session view then shows `memory from before 0.36, not credited · <n> files`.

Nothing is deleted. The reading that counts is the final save of the worktree's last shared-home
workspace. A reading taken before that is provisional: the worktree's line adds
`· read again when this worktree runs each person as themselves`, and Mend reads again when the
worktree first runs per person, crediting only what it had not credited before.

## Codex

Codex keeps its memory too, and Mend carries it per person per project the same way. Codex's memory
works differently from Claude's:

- **It builds memory from your past conversations** when a session starts. It takes up to two that
  have been quiet for six hours, summarises them with model calls on your own login, and merges the
  summaries into its memory. So a conversation becomes memory in a later session, six or more hours
  after it ended.
- **Mend turns the feature on** in every Codex session it starts. It is off by default in Codex.
- **Mend carries your earlier Codex conversations on the project** into each new session, a few at a
  time, so Codex has something to learn from. They show in that session's `codex resume` list.
- **`mend memory import`** brings the summaries Codex made on your machine of conversations held in
  the repository. Codex's own memory folder covers every repository you use it in, so it is never
  imported.

In `mend memory`, Codex's files are listed with `codex` in the first column. Name one as
`codex:MEMORY.md` to show or remove it.

Mend keeps up to 2,000 files and 32 MB per person per project. No file may be over 1 MB, except
Codex's summary database, which may reach 16 MB.

## Other harnesses

pi and opencode keep no memory of their own.
