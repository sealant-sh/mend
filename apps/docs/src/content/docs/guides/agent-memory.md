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
receive theirs. When someone steers your session under shared control, what the agent learns goes
into your memory, as it runs on your login.

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
  two share once. `MEMORY.md` keeps each line once. A note's frontmatter is merged key by key. Where
  the two give a key different values, Mend's value stays and your machine's is kept under it as a
  comment (`# from <host>, <date>: description: …`), which the agent reads and can fold in.
- **updated**: a file Mend has not changed since your last import from this checkout, which your
  machine has. Your machine's replaces it.
- **kept**: a file Mend changed since your last import, and your machine did not.
- **not added**: a file Mend removed since your last import, and your machine did not change.
- **conflict**: a file both sides changed that is not text, such as an image. Mend's stays, your
  machine's is kept as a version, and the next import names it again.

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
