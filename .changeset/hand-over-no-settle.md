---
"@sealant/mend": patch
---

A change of sender under shared control no longer settles the session. The hand-over stops one
person's agent before the next person's starts, and in that gap the session read as settled: Mend
queued the owner's automatic tour and suggestions on the owner's login, a Slack thread could get its
end-of-session summary mid-conversation, and phones were notified of a settle that did not happen.
The session now stays running through the hand-over and settles once, when the conversation ends.
