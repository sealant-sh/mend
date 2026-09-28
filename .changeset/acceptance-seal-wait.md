---
"@sealant/mend": patch
---

The packaged acceptance waits for a stopped session's executor as long as a Garage-backed seal can take (about 10.5 minutes), instead of three minutes, so a release is no longer refused for keeping an executor until its work is sealed.
