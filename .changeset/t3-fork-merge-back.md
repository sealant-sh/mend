---
"@sealant/mend": patch
---

T3 Code's Merge back saves a fork's selected context for its direct parent's next message. A newer
merge-back from the same fork replaces its pending context. The action starts no turn, performs no
Git merge and copies no files. Saved context survives Stop, Resume and deleting the fork; the
parent's next message uses its sender's usual login.
