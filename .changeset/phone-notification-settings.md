---
"@sealant/mend": minor
---

Phone notifications no longer repeat a Slack thread. A session started from Slack pushes only what
its thread does not already say: a failure (the thread marks it with an edit and ❌, which Slack
does not notify), a question or approval in a channel thread whose project is private (that thread
gets no replies), and everything once the organization's Slack app is removed. A finished turn, a
completed session, and a question or approval the thread posts do not push. Each person now chooses
what reaches their phones, in the phone's Settings → Notifications: turn finished, needs your input
and failed (on by default), and sessions started from Slack (off by default). `GET` and
`PUT /api/me/notifications` carry the setting; migration 0096 stores it, and an account with none
saved hears the defaults. The idle stop and a person's own stop never push, even while the idle stop
is on its way. On the phone, a push about the session on screen, its conversation or its terminal,
stays silent.
