---
"@sealant/mend": patch
---

Starting a session from the web app is one request: Mend makes the session and launches its agent
together, so closing the tab or reloading the page the moment you press Enter no longer leaves a
session that reads Starting for good with your first message gone. A page reloaded during a start
comes back to the session, with its first message, instead of an empty composer. If Mend never got
the start, or refused it, the composer gets your words back with the reason.
