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
mend memory import --dry-run   # list what would be imported
mend memory import             # import it
```

Each file Mend does not have yet is added. A file Mend already has with other contents is left as
Mend has it, and the output says which. Only the memory is read: never transcripts, logins or
settings.

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

Mend keeps up to 2,000 files and 8 MB per person per project, and no file over 1 MB.

## Other harnesses

Only Claude Code's memory is carried today. Codex builds its memory from the conversations already
in its home, which a session does not bring from another, so Codex memory stays with each session.
pi and opencode keep no memory of their own.
