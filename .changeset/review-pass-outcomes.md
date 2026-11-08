---
"@sealant/mend": patch
---

Review tours stop showing "Writing…" indefinitely when inference stalls, defects, or is interrupted.
Review passes now time out after five minutes and record a plain failure. Opening review also
expires abandoned running passes from older builds, so they can be requested again.
