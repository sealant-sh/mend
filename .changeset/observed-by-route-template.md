---
"@sealant/mend": patch
---

Mend's server and the t3code gateway now log and trace each request by its route's template, never
by the URL a client sent. A request's log line reads `"http.route":"/api/sessions/:id"` with its
method, status (or `aborted`) and duration, and a request no route answered reads `unrouted`.
Before, the line held the request's path, so a CLI sign-in's user code (`/api/me/cli-auth/<code>`)
reached the log, and a span held the path and query, so the t3code gateway's `?wsTicket=` reached
it. A span now records no URL and no header, and fails only for a 5xx or an aborted request.

The cost: a log line names the route, not the session or project it was for.

The web tier's log about a failed call to Mend's server names the call
(`userDevices.cliAuthRequest`) instead of the server URL it used.

The edge that `mend server setup --edge` writes keeps paths in Mend's log, and now redacts the
segment after `/join/`, `/reset/` and `/slack/link/` (links issued before this version),
`/api/me/cli-auth/`, `/api/devices/` and `/api/auth/reset-password/`, in any case and with repeated
slashes: an old invitation link is logged as `/join/REDACTED`. `mend server upgrade` from this
version writes the new edge files. Lines written before the upgrade keep what they hold.
