---
"@sealant/mend": minor
---

Add `MEND_EXPOSURE` (`loopback`, `private` (the default), `public`) and the public exposure gate.
How an instance is reached is the operator's statement, since a server cannot observe what is
published in front of it; Mend reports what it observes beside it. `MEND_EXPOSURE=public` refuses to
start while an item Mend can observe is open: https browser origins, `Secure` session cookies,
trusted proxies set and not wildcarded, every multi mode gate item (an operator account included),
every budget, URL bearers refused, error redaction on, and a session channel that is https or
declared private (`MEND_EXECUTOR_NETWORK=private`). Items no build can observe (Sealant and the
database not reachable from outside, the edge's certificate, an independent reassessment recorded
with `MEND_EXPOSURE_REASSESSED=<version>`) are reported as open or declared and never block a start;
the first two close only when the operator, having checked from outside, names them in
`MEND_EXPOSURE_DECLARED`. What the build contains and the API cannot see in effect (invitation-only
registration, the web tier's header policy) is reported as carried, not observed.
`mend operator exposure` prints the report; `/health`, which needs no sign-in, carries the declared
exposure and how many items are open, never which. The gate reports what was observed; it never says
an instance is fit to expose.

Session cookies are now explicitly `HttpOnly` and `SameSite=Lax`, and `Secure` whenever `APP_URL` is
https. The Helm chart (0.3.0) can render an Ingress to the web Service only, refused without TLS or
with a browser origin that is not its host, and its NetworkPolicy admits the ingress controller's
Pods by namespace and label. A Compose install run by hand gains an opt-in TLS edge,
`deploy/docker/compose.edge.yaml` with a Caddyfile that keeps tickets and tokens out of its log;
`mend server setup` installs do not apply it yet.
