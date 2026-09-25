---
"@sealant/mend": minor
---

A stop ends the agent and leaves Services running, and a running Service keeps the workspace up.
Every surface now says so: the web session page and project list, the desktop inbox and terminal
header, and `mend sessions` and the dashboard read, for example,
`agent stopped · 3 services keep the workspace up`. Stop services (`mend stop --services`, ⇧K on
such a row in the dashboard, the button on the session page, and the desktop's stop services) stops
all of them, and the workspace ends once nothing is live. Review prep now starts when the agent
stops or exits, even while Services keep the workspace up.
