---
"@sealant/mend": patch
---

A final flush that Core's deadline or sealantd's own shutdown started is no longer refused for the
byte or call quota. sealantd marks such requests `"flush":"final"`, and Mend exempts them whether or
not it is draining the session, logging the bytes it admits over the quota.

Mend refuses to adopt SHA-256 repositories ("Mend doesn't support SHA-256 repositories yet.") and
removes the clone. A SHA-256 project adopted earlier is refused the same way when a session starts
on it.

Status lines no longer call a registered capture saved:
`executor not answering · last capture 10 at 07:33:53 UTC · not confirmed` replaces
`last saved capture 10 …`. A session whose executor the platform keeps for recovery reads
`stopping · retained` instead of `running`, and a resumed session no longer shows the previous
executor's `stopped outside Mend · saved at …` line.

A launch that claimed a standby whose re-plan failed, and which held nothing, goes on with a cold
executor at once (with sealantd's matching fix) instead of failing after about 12 minutes.

The docs site has a new Known issues page: the seal wait on Garage, SHA-256 repositories, how build
output carried from another platform is checked, and what a machine failure can lose.
