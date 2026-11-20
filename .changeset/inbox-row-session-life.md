---
"@sealant/mend": minor
---

Each row of the sessions inbox (`GET /api/session-inbox`, and `GET /api/sessions/:id/inbox-row`,
which the event stream re-reads) says three more things, so a client can place a session by its life
and draw its glyph:

- `turnOpen`: whether the agent is on a turn. True while a terminal agent or a command runs, or a
  conversation has a turn queued or running; false between a conversation's turns (it still reads
  `running`) and whenever the session isn't `running`.
- `lastNewAt`: when something new last happened in the session: an agent started (a launch or a
  resume), a turn was sent, the agent asked, or someone answered it. A person's done or snooze mark
  made before it no longer holds.
- `annotation.pullRequestState`: the state of the change's newest pull request (`open`, `merged`,
  `closed`), or null.

Older clients ignore them.
