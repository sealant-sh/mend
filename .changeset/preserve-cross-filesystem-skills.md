---
"@sealant/mend": patch
---

Preserve skill modes, modification times and internal hard links when moving them across
filesystems. Verify a staged copy before removing the original, and refuse delivery when the copy
capability or preservation checks fail.
