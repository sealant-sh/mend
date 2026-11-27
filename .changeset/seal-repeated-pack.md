---
"@sealant/mend": patch
---

A session whose worktree came back to files an earlier save already held (going back to a
checkpoint, or a run writing the same files again) now finishes saving when it stops. Before, its
Stop read `stopping · not saved · final seal not confirmed` for as long as the server ran, and the
next session in that worktree waited on it. When Mend cannot finish checking a save, the `not saved`
line now says what it could not check.
