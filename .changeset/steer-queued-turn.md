---
"@sealant/mend": patch
---

When someone else steers a shared session, their turn now runs. Before, Mend handed the conversation
to a new agent process running as the sender, but cancelled the waiting turn first, with no error,
so the new process started with nothing to run. A turn sent while the conversation was between
processes was cancelled the same way. Both now move to the new process and run there, on the
sender's login, and the sender is recorded as the turn's payer.
