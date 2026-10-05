---
"@sealant/mend": patch
---

A new session's executor is no longer replaced about two minutes after launch. Mend plans the
replacement ahead of the platform's 8 h cap and moves it earlier when what is pending would take
longer to upload, at the rate it observed between two flushes. A fresh executor ships a few KB of
small captures a second while its ~800 MB `node_modules` bulk is still being built. That read as ~13
KB/s, an upload of 16 h, and the replacement fell due at once. It ended open shells, made a join
wait 25–60 s for the replacement, and left a Stop nothing of its own to save. The plan now counts
the upload at no less than 1 MB/s (one registration a second for captures), since the observed rate
shows what was shipped, not what the store can take. What is pending moves the replacement no
earlier than halfway through the executor's life. A replacement still starts in time when a large
upload would not finish before the cap.
