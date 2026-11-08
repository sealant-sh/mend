---
"@sealant/mend": patch
---

A screen whose start reply was lost now waits for its whole process group to end before reading as
ended. A desktop session child that survives TERM is killed, and a later Stop can still find the
group after Xvnc removes its lock file.
