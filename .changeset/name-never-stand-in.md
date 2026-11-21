---
"@sealant/mend": patch
---

Mend no longer names a session "placeholder", "untitled", "new session" or the project's name. When
a session's first message doesn't say what the work is ("hi", "test"), it stays unnamed and reads as
that message. Once a later message says what the work is, Mend names the session from it.
