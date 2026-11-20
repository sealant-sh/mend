---
"@sealant/mend": patch
---

Stopping a session's agent no longer sometimes closes a shell you have open beside it. When the
agent ended the instant its terminal closed, Mend could see that end before the stop recorded it,
read the stop as one with no agent to end, and close the session's shells too. The shell now stays
open and keeps the workspace up, as it does on every other stop.
