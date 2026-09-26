---
"@sealant/mend": minor
---

A conversation session (started from Slack, or from the web or phone composer) no longer keeps its
agent and workspace up until the platform's cap ends it. Mend stops an agent that has sat idle for
`MEND_PROTOCOL_IDLE_STOP_MINUTES` (default 15; 0 turns the stop off): no turn in flight, no question
or approval waiting, no live Service and no open shell. The stop is the Stop button's, so review
prep runs, and the session reads `idle · stopped after 15 min · reply to resume`, with an
`idle-stop` in its control log. The Slack thread's status message says the same and its reaction
becomes 💤. The next message, a Slack reply or Resume, continues the same conversation. Migration
0072 adds the claim that stops each session once across workers.
