---
"@sealant/mend": patch
---

Keep terminal embed renewal tickets limited to twelve hours from the original URL mint, even when
the first exchange is delayed. Later exchanges reuse that deadline, and socket tickets still last
thirty seconds from their own mint.
