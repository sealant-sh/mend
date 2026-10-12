---
"@sealant/mend": patch
---

Remove temporary filesystem blob uploads after stream errors or interruption, waiting for the
streams to close before cleanup. Failed uploads preserve any existing object.
