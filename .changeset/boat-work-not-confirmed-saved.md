---
"@sealant/mend": patch
---

A session whose executor ended with its work not confirmed saved no longer reads as a clean stop.
When Sealant records a removed executor's drain as `gone`, the session settles `failed` and reads
`executor gone · work not confirmed saved`, followed by its last saved or registered capture and the
platform's reason. That holds even after you pressed Stop or the agent completed. A capture that
Mend itself sealed still reads saved, and a discard the platform recorded reads
`unsaved work discarded`. When Sealant recorded the work saved and Mend holds no save of its own,
the session stops cleanly and reads `saved at <time> · confirmed by the platform`. T3 Code shows a
failed session as an error with its summary instead of as stopped.
