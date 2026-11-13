---
"@sealant/mend": minor
---

Before an owner changes where an organization's new sessions run, Mend lists what the new runtime
would not run, from Sealant's report: the organization's environment, projects whose environment it
cannot start, Services on a port it holds, and server folders it cannot bind. Other members' private
projects are counted, never named. The owner can move the environments to one the runtime runs in
the same step, or switch without moving anything; the list then stays on Settings · Organization ·
Defaults with the same move. Each move is in the audit log. Clients read the list at
`GET /api/organization/settings/session-runtime/impact` and move with `moves` on
`PUT /api/organization/settings/session-runtime`; a request without `moves` works as before.
