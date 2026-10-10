---
"@sealant/mend": minor
---

The t3code gateway (docs/adr/0012): `mend server setup --t3-gateway` turns it on. t3code's desktop,
mobile and web clients add it as an environment, pair with a code from `mend pair`, and see this
Mend's projects and sessions as their projects and threads: start a thread in a new or an existing
worktree, send messages and images, queue, edit and reorder what waits, answer approvals, rename,
stop, archive and delete, read each turn's diff and the thread's files, and open a terminal, each as
the person who paired and under Mend's own rules. It runs in the Mend container on a listener of its
own, published on 127.0.0.1 only (port 3120, or `--t3-gateway-port`); reaching it from another
machine is an exposure the operator puts in front of it and declares. `--no-t3-gateway` turns it
off. Off, nothing of it runs.
