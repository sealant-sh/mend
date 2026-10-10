---
"@sealant/mend": patch
---

Opening a review or marking a checkpoint while a session is stopping no longer hangs. The checkpoint
uses the Stop's final save, which holds everything the session saved, and Mend does not ask the
stopping executor again. The web, phone and terminal reviews say where that checkpoint came from,
with the time of that save, for example `from the Stop's final save · capture 12 · 10:16`. They
never show it as a fresh observation. A landing during a Stop waits for the Stop to finish, then
lands what it saved. If the Stop takes longer than 45 seconds, the landing is refused with "the
session is stopping", and nothing is landed. Opening a review answers within 90 seconds, or says it
did not finish.
