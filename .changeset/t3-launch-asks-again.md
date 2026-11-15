---
"@sealant/mend": patch
---

A T3 Code launch in a new worktree no longer fails when Mend leaves one of the startup wait's
session reads unanswered, as it can while several workspaces start together. The gateway asks again
a second later, until the launch's 10-minute deadline. Only a refused device or a missing session
ends the wait sooner. Asking again only re-reads the session, so the opening message is still sent
once. The server logs a session read that takes a second or more (`session detail read was slow`).
