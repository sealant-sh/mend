---
"@sealant/mend": patch
---

Accept an inference answer returned after the last permitted tool round instead of reporting that
the tool loop exhausted its budget. Further tool calls remain bounded by the requested limit.
