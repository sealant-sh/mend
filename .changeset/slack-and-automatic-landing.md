---
"@sealant/mend": minor
---

Mend in Slack (ADR 0006): an organization owner connects a Slack app made from Mend's manifest
(Settings → Slack, Socket Mode, outbound only). `@mend <prompt>` in a thread starts a session for
the linked person in the project the message, the thread or a default names, reports into the
thread, and takes follow-ups there.

Automatic landing (ADR 0007): a session started from Slack pushes its branch and opens or updates a
pull request after a turn that asked for a change, never for a question. Projects can turn it on for
their own sessions ("Land when a turn completes") or off for every session; `autopr=` in a Slack
request overrides it.
