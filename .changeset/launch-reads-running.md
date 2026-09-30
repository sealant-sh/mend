---
"@sealant/mend": patch
---

A session whose agent is running reads `running`, with its start time stamped. A client that gave up
on a launch request (or a phone app sent to the background) no longer cuts the launch between the
agent's start and its process row, and a session's `started_at` is no longer left empty.
