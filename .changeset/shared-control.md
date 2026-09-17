---
"@sealant/mend": minor
---

A session's owner can turn on shared control, letting anyone who can see the session steer it on the
owner's credentials; the owner or an organization owner can turn it off. Session detail says what
the viewer may do (steer, stop, change shared control). Interrupts, terminal attaches, shell opens,
stops and shared control changes are recorded per session with who did them, and shared control
changes also go to the audit log. While control is shared, notifications also reach whoever sent the
latest turn. Removing a member turns off shared control on their sessions first.
