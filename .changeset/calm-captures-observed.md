---
"@sealant/mend": patch
---

Recompute change summaries only from reads stamped with the requested capture, including the base
when comparing the posted summary. Persist separate immutable observed bytes before publishing their
pointer and observed state together, refusing publication if the head, base, verification result or
claimed state changed while the observer was working.
