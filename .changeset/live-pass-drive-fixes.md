---
"@sealant/mend": patch
---

A foreground `mend claude` or `mend codex` now stops its session when its terminal closes (a closed
window, `tmux kill-session`). The CLI's write to the dead terminal failed with EIO and the CLI
exited before its stop went out, so the session kept running; the stop now goes out first, as on
SIGHUP, and the CLI exits quietly.

On the web, clicking a line number in a review puts the cursor in the comment box it opens, and a
right-click menu takes focus once it shows, so Escape closes it and the arrow keys move through it.
The worktree menu's `Copy worktree path` is now `Copy directory name`, which is what it copies: a
captured worktree has no directory on the server.

`Send review to session` is no longer offered for a `mend run` session, on the web and on the phone:
a command has no agent for the review to start. The review says so instead, and the server refuses
such a delivery in those words before recording anything.
