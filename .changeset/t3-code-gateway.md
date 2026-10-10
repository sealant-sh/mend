---
"@sealant/mend": minor
---

The t3code gateway (docs/adr/0012): `mend server setup --t3-gateway` turns it on. t3code's desktop,
mobile and web clients add it as an environment, pair with a code from `mend pair`, and see this
Mend's projects and sessions as their projects and threads: start a thread in a new or an existing
worktree, from a base branch, send messages and images, @-mention project files, queue, edit and
reorder what waits, answer approvals, choose the permission mode for the agent's next start, rename,
stop, archive and delete, read each turn's diff, the thread's files and its change, and open a
terminal, each as the person who paired and under Mend's own rules. t3code shows a provider as
connected only when Mend holds that person's login for it.

It runs in the Mend container on a listener of its own, published on 127.0.0.1 only (port 3120, or
`--t3-gateway-port`), and setup and `mend server status` say whether it answered there. Reaching it
from another machine is an exposure the operator puts in front of it: while the gateway is on, the
public exposure gate lists `t3code-gateway` as open until `--declare t3code-gateway`.
`--no-t3-gateway` turns it off. Off, nothing of it runs and the gate lists nothing about it.

It speaks t3code `v0.0.46-nightly.20261010.2922` (a client of the previous nightly still pairs) and
checks every call against the paired client's scopes, as t3code's own server does. Its state file
holds every paired person's Mend device token and is readable only by the gateway's user (`0600` in
a `0700` directory). Failed pairing codes count per client, and a client Mend rate-limits gets `429`
with Mend's `retry-after`. Revoking a `t3code · …` device in Mend signs that client out: t3code
shows "Connection failed: The environment credential is invalid." and stops reconnecting. While Mend
cannot be reached, the gateway answers new connections and snapshot reads with a retryable `503`.
Deleting a thread's worktree from t3code says that Mend keeps it and where to remove it.
