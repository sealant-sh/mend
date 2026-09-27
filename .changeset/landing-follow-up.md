---
"@sealant/mend": minor
---

Landing says why it did not land, and a request to land lands. Every turn automatic landing decides
records a reason and logs it; beside a question, `autopr=false`, landing off and someone else's
turn, a turn now reads `not landed · the change is empty`,
`not landed · nothing new since the last landing` or `not landed · the change was not captured`
(migration 0073). Before it reads the change for a landing, Mend asks the executor to flush its
captures, up to three times: a stale head is neither landed nor called empty. Follow-ups are read
before the change, and a request can read as `land` ("land it", "open a PR"), which lands the
owner's change even when the turn changed nothing, and in a Slack thread even with automatic landing
off. Inside a workspace, `mend land` lands the session's change as its owner and prints what was
pushed and what GitHub said, or why not; the opening prompt tells the agent to run it when asked to
publish, and never to push itself.
