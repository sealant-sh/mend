---
"@sealant/mend": patch
---

A hot-pool standby in capture mode no longer runs anything before a session claims it. Mend used to
run its helper install and workspace note in every standby right after it booted, which told the
executor it held a session's work. A standby whose replan then failed wedged for about eleven
minutes and ended `failed` with a discard needed, and shrinking the pool never released it. The
setup commands, the helper and the note now run at claim, after the replan.

After a `docker stop` outside Mend that saved, the session now settles
`stopped outside Mend · saved at … · capture <n>`. Before, Core reported the executor `failed` with
its container removed, and Mend read that as kept, so the session stayed `stopping`. An executor
Core retains for recovery still reads as kept.
