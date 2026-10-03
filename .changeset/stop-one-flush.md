---
"@sealant/mend": patch
---

A Stop asks its executor for one final save instead of three small ones first. The stop's checkpoint
and the agent's harvest read that save. On the box this was 8.6 s of a 25 s Stop, and `mend stop`
answered only after the first of those saves.
