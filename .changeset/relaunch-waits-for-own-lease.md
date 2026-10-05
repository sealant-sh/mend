---
"@sealant/mend": patch
---

A relaunch, resume or executor replacement waits for the session's own earlier executor to give up
the worktree before it creates the next one. Mend read a lease that an earlier executor of the same
session held as free: the next executor booted and waited for that lease until the platform gave up
on it. Ending one executor also no longer releases a lease that a later executor of the same session
holds.
