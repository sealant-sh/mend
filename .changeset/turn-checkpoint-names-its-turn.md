---
"@sealant/mend": patch
---

A conversation turn's checkpoint now sits after the turn it belongs to.

- **The right line after each turn.** Mend records which turn each checkpoint was taken for, so a
  message sent the moment a turn ends no longer moves that turn's checkpoint under the next turn.
  Going back to a turn's line gives that turn's files, and Show changes opens that turn's changes.
- **A message sent as a turn ends waits for its checkpoint.** It reaches the agent once Mend has
  saved the turn's files, usually a fraction of a second later, so the checkpoint holds only that
  turn's changes. If saving takes longer than 10 seconds, the message is sent anyway.
- **A checkpoint Mend can't vouch for says so.** When the next turn had already started, or the
  workspace hadn't confirmed it saved the turn's last changes, the checkpoint is still taken and its
  details say which.
