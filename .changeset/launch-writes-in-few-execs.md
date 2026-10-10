---
"@sealant/mend": patch
---

A session starts without waiting on one exec per file. The skills, agent memory, pi profile and
pasted images Mend writes into a capture-mode workspace now go in one exec per delivery, and a skill
that sits in each harness's directory travels once. On the Docker box a new session wrote a 1.9 MB
skills library in 103 execs and its memory in 11, about 60 s of a 90 s start; both now take one exec
each.
