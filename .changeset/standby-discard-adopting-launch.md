---
"@sealant/mend": patch
---

A session that starts on a warm standby workspace keeps that workspace. Before this fix, one rare
ordering could remove it without saving about a second after the session started: Mend drained the
standby while a launch claimed it, and the ten-minute hot pool sweep marked the claim failed in
between. Mend now checks for the session again once the standby is out of the pool, and stops a
workspace that has a session as a session's workspace, which saves its work. Standbys that nobody
claimed are still discarded, so their VMs end on Boat.
