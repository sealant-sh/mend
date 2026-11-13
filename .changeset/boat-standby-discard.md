---
"@sealant/mend": patch
---

A standby workspace on Boat now ends when Mend stops it. Mend used to stop a standby the way it
stops a session, asking Sealant to save its last changes first, but a standby holds no worktree, so
Mend never accepts anything from it, and Sealant kept its VM running and billed with no end. This
happened whenever the pool shrank: hot sessions set lower, a project's environment changed, or the
organization's Boat key removed. Mend now tells Sealant there is nothing to keep, but only for a
standby still in the pool: once a launch has claimed it, it is stopped as a session is and its work
is kept. A standby left in this state by an older Mend is ended on the next hot-session check. A
standby whose end Sealant has not confirmed now counts toward the project's hot-session count, so no
new one starts beside it.
