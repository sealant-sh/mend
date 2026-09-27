---
"@sealant/mend": minor
---

A stop no longer loses work an executor has not shipped. In capture mode every stop Mend asks for
(the Stop button, `mend stop`, the idle stop, a relaunch, a replacement ahead of the platform's cap)
drains first: Mend flushes, reads what is left and repeats until nothing is pending, then terminates
the workspace, and releases the worktree lease only once the platform reports the workspace gone.
While it drains the session reads `saving · 3 left` on the web, in `mend status`, on the phone and
in its Slack thread. A drain that moves nothing for `MEND_CAPTURE_DRAIN_STALL_SECONDS` (default 600)
reads `not saved · 3 pending · workspace kept`, tells the owner's phone once, and keeps the
workspace; only the owner's **Discard unsaved and stop** (audited) ends it. The idle stop waits
while captures are still shipping. `MEND_EXECUTOR_MAX_SECONDS` states the platform's cap, and a
planned drain starts ahead of it, counted from the executor's own start. An executor the platform
does not answer for is no longer taken for dead, and a session removed while its workspace is up is
removed once the workspace has gone. Migration 0075 adds the capture columns to sessions.
