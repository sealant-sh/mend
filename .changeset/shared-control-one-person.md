---
"@sealant/mend": minor
---

Shared control can now go to one person. Someone who can see another person's session asks for it,
and the owner grants or declines the ask. Only the people the owner granted it to can send messages
and answer the agent; everyone else reads. The owner, or an organization owner, can take it back
from a person: their waiting messages are not sent, and a turn of theirs already running finishes.
An ask ends when the session ends.

- `GET /api/sessions/:id/shared-control` says who holds it (`granted`), who asks (`asked`: every ask
  for the owner, only your own for anyone else), whether shared control with everyone is on
  (`everyoneSince`) and what you may do (`acts`). `POST …/shared-control/ask`, `…/withdraw`, and
  `…/people/:userId/grant`, `…/decline` and `…/take-back` each answer the same read. A step the
  session no longer allows answers 409 `SharedControlRefused` with a `reason`.
- Sessions carry `sharedControlUserIds`, the people granted it, and the inbox row of your own
  session carries `sharedControlAsks`.
- A message from someone steering whose own login is missing, expired or not chosen is refused with
  `login: { provider, state }` beside the words, so a client can offer connecting it again.
- The switch for everyone is unchanged: `mend session share <session> on` lets everyone who can see
  the project steer. `off` now also ends every grant, so only the owner steers afterwards.
