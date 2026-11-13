---
"@sealant/mend": minor
---

A Boat session that does not start says why, who can fix it and what to do.

- **One sentence per reason Boat gives.** When Boat refuses to start a session's VM, or does not
  answer, the session ends with `launch failed ·` and what happened (the Boat key expired, it lacks
  a permission, the wallet needs paying, the plan's VM limit is reached, Boat has no machine free,
  and the rest), then who can fix it and how: an owner of the organization when it has its own Boat
  key, the person who runs the server when the session used the server's key, or the person
  themselves when only a retry is needed. Boat's billing link and the time Boat asked to wait are
  included when Boat sent them. The first line stands alone, so the dashboard's one line says
  enough.
- **Refused before anything ran reads `launch refused`.** Boat not set up on the server, no resource
  gateway, and an environment Boat cannot run now read `launch refused ·`, not `launch failed:`.
- **Boat's own code and request id go to the server log** (`boat refused · …`), never into the
  sentence.
- **The Boat page and `mend boat connect` word a key Boat refused the same way**, including an
  expired key and a check Boat asked to wait on.
- **The Boat docs page lists every reason** in the words a session shows.
