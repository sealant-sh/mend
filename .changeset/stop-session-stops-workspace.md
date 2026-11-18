---
"@sealant/mend": minor
---

`mend stop` now stops the workspace and its Services too when no other session is running in that
workspace, once the session's work is saved. When another session is running there, only your
session stops, and `mend stop` says which session keeps the workspace running.
