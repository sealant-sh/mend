---
"@sealant/mend": patch
---

The T3 Code gateway speaks t3code v0.1.2. Pair a t3code v0.1.2 client with Mend. "Send now" on a
queued message sends it when the thread is stopped, and is refused while a turn runs, as t3code's
own server refuses it. Settle and snooze follow v0.1.2's rules: a turn that completes no longer
wakes a snoozed thread, settling ends a snooze, and a replayed command is applied once. A terminal
that was closed or stopped stays that way when a client reconnects. A missing `t3.json` reads as
absent, not as a failed read.
