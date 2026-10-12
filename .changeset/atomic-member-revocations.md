---
"@sealant/mend": patch
---

Commit every local credential and control revocation together when removing an organization member.
Dispatch connection and session cleanup before notifications, so interrupted requests and failed
notifications cannot leave a partially removed account.
