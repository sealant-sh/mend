---
"@sealant/mend": patch
---

Bounded git reads (diffs, searches) start their deadline the moment git starts again. Since the
store moved to the Effect Clock, the deadline started only once the runtime got to a background
task, so on a busy server a slow git could run past its bound and answer in full instead of being
stopped with the output it had printed so far.
