---
"@sealant/mend": patch
---

Opening a review, marking a checkpoint or landing while a session is stopping no longer hangs. A
checkpoint taken during a Stop now uses the Stop's own final capture, which holds everything the
session saved. It does not ask the stopping executor again. A checkpoint a request asks for answers
within 90 seconds, or says it did not finish.
