---
"@sealant/mend": patch
---

Claude Code no longer updates itself inside a workspace. 10–30 s after the first Claude started, it
updated itself (2.1.287 to 2.1.289) and left its native binary as a 500-byte stub, so every later
`claude` in that workspace (a join, a second session) failed with "claude native binary not
installed". Every workspace now starts with `DISABLE_AUTOUPDATER=1` (and opencode's and pi's own
update switches), which reaches a `claude` typed in a shell too, and Claude's launch seed sets it
again for workspaces started before this release. A project variable of the same name still wins.

A launch that exits non-zero now settles `failed` whichever of Mend's two observers sees its end
first. Core settles an interactive session's run `completed` whatever its process exited with, so a
join that could not start read `completed` when the run's supervision saw it before the terminal
watcher did.
