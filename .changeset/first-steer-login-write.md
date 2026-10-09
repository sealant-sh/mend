---
"@sealant/mend": patch
---

Shared control with per-person homes: the first turn a person sends into someone else's session no
longer fails with "logins could not be written into this workspace". Mend now writes their logins
only once their user and home exist. A write that still fails is tried once more, and if it fails
again their turn is refused with the reason. It never runs on another person's agent or login.
