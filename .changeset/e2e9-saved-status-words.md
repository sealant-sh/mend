---
"@sealant/mend": patch
---

Two status lines now say what was saved. A launch that failed, and whose kept executor the platform
ended after it sealed, reads `launch failed: … · saved at … · capture <n>`. A session Mend stopped
because its executor ran a final flush on its own (a `docker stop`, a platform deadline) reads
`stopped outside Mend · saved at … · capture <n>` once saved, as other sessions ended outside Mend
do.
