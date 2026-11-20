---
"@sealant/mend": patch
---

A session's line no longer says "per-person users not yet known for this image; checked while this
workspace starts" while Mend checks a new workspace image. The check still runs during the start,
and the next launch on that image uses its answer.
