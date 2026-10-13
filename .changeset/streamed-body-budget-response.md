---
"@sealant/mend": patch
---

Return a body-budget refusal for oversized streamed API requests instead of an internal server
error. Keep unrelated read failures and interrupted requests unchanged.
