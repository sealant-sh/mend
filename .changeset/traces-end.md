---
"@sealant/mend": patch
---

Mend's traces in Sentry end. A Mend process with telemetry off, such as the T3 gateway, which the
server never gives a DSN, makes no spans and sends no `traceparent`. Before, a gateway's polling put
a day's requests into one trace. An event stream's or a socket's request span ends once it opens.
What a running session does after its launch (supervision, process watchers, capture flushes,
naming) is in traces of its own, linked to the start, so the start's trace shows the launch while
the session runs. A sweep or a reaper pass that found nothing to do leaves no trace. The bundled
sealant is 0.40.0-next.956, whose SDK sends no trace header when the caller's tracing is off.
