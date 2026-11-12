---
"@sealant/mend": patch
---

An idle-stopped session keeps its summary, such as
`idle · stopped after 15 min · mend resume --with shell reopens it`. Its process could exit while
the stop was still saving its work. The settle for that exit then replaced the summary with none, so
the session read only `stopped`. The words a stop asks for now outlast every settle until the
session runs again.
