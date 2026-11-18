---
"@sealant/mend": patch
---

The server's inbox read (`GET /api/session-inbox` and one row's `GET /api/sessions/:id/inbox-row`)
says more about each session, from Mend's own records and without reading a worktree:

- `annotation.fileCount`: how many files the session's change has against its base, counted each
  time Mend takes a checkpoint. Null until one was counted.
- `worktreeName`: the worktree's name as lists show it.
- `failure`: for a failed session, why it ended, as Mend recorded it (`exited with code 3`).
- `activity`: for a running conversation, what its agent is doing now: running a command, editing a
  file, searching, using a tool, thinking, writing or planning, with the command, file or tool when
  the agent named one.

All four are new and optional, so clients that don't read them see no change.
