---
"@sealant/mend": patch
---

Mend's web server joins the trace a browser or a client starts: each call it handles is a span of
its own, the calls it makes to Mend's API are children of it, and the caller's trace goes on to the
API. With `SENTRY_DSN` set, the web server sends those spans to Sentry, and reports a failure of its
own (Mend's API not answering, an answer it cannot read, a bug) with the trace it happened in.
Refusals the API answered are not reported again. Without a DSN nothing is sent.
