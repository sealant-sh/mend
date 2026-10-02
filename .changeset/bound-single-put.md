---
"@sealant/mend": patch
---

On Garage, a Stop no longer waits 10 minutes after uploading large files: an object up to 256 MB
goes up as one upload bound to its bytes instead of in parts, so nothing holds the save open.
