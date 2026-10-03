---
"@sealant/mend": patch
---

Reading an agent's memory and transcript back from a save fetches each pack once. A Codex memory
read-back of 33 small files fetched the same 64 MB pack 33 times, 28 s of a Stop on the box.
