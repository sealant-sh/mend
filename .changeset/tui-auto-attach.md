---
"@sealant/mend": patch
---

A session you start or resume from the dashboard attaches by itself once it runs, if you are still
waiting on it. You no longer have to press `a`. The status line reads `ready · <name> · attaching`
for a moment, with the snake's score when you played meanwhile, and then the terminal is the
session's. If you moved to another session, column or project, or a dialog is open when the session
runs, nothing takes the terminal. The status line reads `started · <name> · a attaches` instead.
With several starts in flight, only the newest attaches. A start that fails, or a session that ends
before it runs, attaches nothing and says so. After a detach the dashboard comes back with the
session selected, and does not attach it again. `MEND_AUTO_ATTACH=off` leaves every attach to `a`.
