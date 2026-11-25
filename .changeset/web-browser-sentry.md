---
"@sealant/mend": patch
---

Mend's web app can report its errors and traces to a Sentry its operator runs: given
`SENTRY_BROWSER_DSN`, the browser loads Sentry's SDK, sends what an error screen caught and a trace
of each page, and carries the trace on its calls to Mend's server. Without it, which is the default,
the browser loads nothing of Sentry and sends nothing anywhere. Nothing about the person, no
cookies, headers, request bodies or query strings are sent, and session replay stays off.

A page that the server drew with a refusal, such as a session that no longer exists, now keeps the
same screen once the browser takes over.
