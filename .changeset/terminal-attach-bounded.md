---
"@sealant/mend": patch
---

Opening a session's terminal now gets an answer within 20 seconds. If the platform is slow to hand
over the terminal, the attach is refused with
`the platform did not attach the terminal within 20 s · the session keeps running · attach again`,
before the CLI gives up on the connection.
