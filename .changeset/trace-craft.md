---
"@sealant/mend": patch
---

When a server reports to Sentry, its traces now read at a glance. Each span is filed under a real
operation with a description: a request under its route, a call to sealant under its path with the
IDs templated out, a database query as a short line naming its table that Sentry no longer blanks to
`[Filtered]`, and Mend's own work as `mend.<area>.<operation>`. Lookups that only passed a call
along no longer add a span of their own, and the web app no longer makes a span for its five-second
read of a session's Executor calls.
