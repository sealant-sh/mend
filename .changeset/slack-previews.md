---
"@sealant/mend": patch
---

A session's Slack thread shows its worktree's previews. Under the status line, each preview has a
line, such as `preview · web · starting · setup`, `preview · web · answered HTTP 200 · observed`,
`preview · web · stopped by Maria` or `preview not prepared · web · <reason>`, and an **Open
preview** button when Mend can open it. The button opens Mend's sign-in for the preview at
`APP_URL`, which checks that the person can see the project. The link holds no credential and no
preview host. The message moves as a preview prepares, starts, fails or stops, whichever session of
the worktree runs it. A readiness check that repeats the same answer does not edit it. The
end-of-session reply carries the previews as they read when it was posted. A Slack Connect channel
shows previews only when the owner turned on external channels. A private project's channel thread
shows none, and making a project private now edits its threads at once. With the preview gateway
off, Slack shows no preview.

The status message has one writer after launch, and Mend compares it whole, so a button that appears
or goes reaches Slack. An edit Slack refuses waits for Slack's `Retry-After`, or backs off, on every
worker, and Mend stops editing a message that was deleted or whose channel is gone. A thread whose
previews cannot be read for a moment keeps the ones it shows, and its replies still post. The Slack
reporter now shares the server's events connection, so a server pins four LISTEN connections instead
of five, and the reporter looks at every active session again when that connection drops and once it
is back, so a change made in between reaches Slack.
