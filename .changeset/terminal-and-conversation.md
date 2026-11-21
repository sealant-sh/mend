---
"@sealant/mend": patch
---

When a session you attached to goes back to being a conversation, whether you chose Continue as a conversation in the web or the terminal stayed closed, `mend attach`, `mend resume` and `mend rejoin` now say it "continued as a conversation" instead of "session ended". `mend message` to a session whose agent runs in a terminal now types the message into that terminal at its next turn boundary.
