---
"@sealant/mend": patch
---

A connected Antigravity login keeps starting new sessions past its first hour. The server bundle now
carries the Antigravity CLI that sealant's keep-fresh sweeper runs to refresh the login, so new and
running Antigravity sessions get a fresh access token instead of the expired one. A login Google
refuses to refresh reads "reconnect needed" in `mend accounts`.
