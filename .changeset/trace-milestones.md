---
"@sealant/mend": patch
---

When a server reports to Sentry, a trace now shows the steps a person would name, in plain words:
`mend.auth — authenticate request`, `mend.access — authorize session`,
`mend.session — launch session`, `mend.sealant — create workspace`. Helpers that only looked up a
row, checked a guard or passed a call along no longer add spans of their own, so a launch no longer
shows a stack of wrappers or an `Autogrouped` block. Health checks no longer make a trace each
unless they fail, and a database query that ran outside any request or background job is no longer
sent on its own.
