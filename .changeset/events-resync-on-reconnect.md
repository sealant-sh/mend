---
"@sealant/mend": patch
---

When the server's events connection to the database drops, the web app, the VS Code extension, T3
Code and the server's own listeners re-read what they show twice: once when it drops, as before, and
again once it listens again. A change made while it was down no longer stays unseen until the next
change.
