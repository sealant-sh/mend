---
"@sealant/mend": patch
---

On a busy server, an agent's first look at a session's screen no longer comes back with no frame.
The two-second limit on decoding a screen frame now starts once the decoder thread is running, not
while it is still starting.
