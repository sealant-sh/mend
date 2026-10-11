---
"@sealant/mend": minor
---

The t3code gateway now offers Settle and Snooze in a thread's menu. t3code hid both for Mend's
threads because the gateway did not advertise them. Like the archive, they are your own view, kept
by the gateway across its restarts: Mend's database is untouched, and someone else sharing the
session does not see your settle or snooze. A snooze wakes at the time you chose, or earlier when
the agent asks for an approval or an answer, or a turn fails or completes. A message sent to a
settled or snoozed thread brings it back. Settle and snooze are part of the core T3 Code workflow
that works with Mend in 0.36; more of T3 Code is coming in 0.36 patch releases, before 0.37.
