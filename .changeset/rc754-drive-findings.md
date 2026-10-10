---
"@sealant/mend": patch
---

Fixes from the 0.36.0-next.754 feature-map drive:

- The web's "Discard unsaved and stop…" works. It always answered an internal error before, and it
  is the only way out of a stalled save.
- A `mend run` session has no agent to resume. Resume on its own harness is gone from the web, the
  phone and the dashboard's picker; a shell or another harness is still offered. The server refuses
  in words:
  `This run session has no agent to resume. Resume it as a shell, or start another session in its worktree.`
- The dashboard's review screen no longer opens the send editor on a `mend run` session. It says
  there is no agent to send the review to, as the web and the phone do.
- `mend server status | head` no longer leaves a stale `server.lock`. A server command whose reader
  went away, or whose terminal closed, finishes what it started, releases the lock and exits 0.
  Every exit through `process.exit` releases a lock still held.
- `mend uninstall` refuses with the lock's words while a server lock is held: which process holds
  it, and how to clear a stale one. It no longer crashes with a stack trace.
- `mend uninstall --all` removes the edge's Caddy image too, after `--no-edge` took the edge away.
- A managed OS family's packages save only when they are in Sealant's catalog. A name the platform
  matched to another project (`tree` → `python-urwidtrees`) is refused at save, not at every launch.
- `mend memory rm codex:memories_1.sqlite` removes Codex's database, as the listing names it.
- A removed member's open page lands on sign-in with the reason, even when the server closes its
  event stream before the reason goes out.
- A failed hand-over's summary no longer ends a sentence with `..`.
