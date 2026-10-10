---
"@sealant/mend": minor
---

A Claude workflow started in a protocol session now shows on the phone while it runs. Its card sits
on the turn that started it and keeps updating after that turn ends: each phase, each agent's state,
model, tokens and current tool, and the totals. Background agents and commands get the same card.
When the workflow ends, Claude starts a turn of its own to report it. Mend used to drop that turn,
so the result never appeared; it is now recorded, reads "the agent continued", and its reply reaches
Slack like any other. A message sent while that turn runs waits for it. Automatic landing decides
that turn by the request that started the workflow. A session whose workflow is still running is
active: the idle stop never ends it, however long the workflow runs or goes quiet, and the phone
shows it working. Once the workflow ends, the idle minutes count from then. A task whose agent
process ended reads stopped.
