---
"@sealant/mend": minor
---

Folders and reference repositories reach captured workspaces, and the multi mode gate passes. A
captured workspace binds no host path, so each folder a project selected now travels with the
session plan as a gzipped archive — a folder as `tar` of its contents, a reference as
`git archive HEAD`, the tree an agent reads without the history behind it. sealantd 0.16.0 lays each
one down beside the worktree, at `/workspace/home/<name>` and `/workspace/ref/<name>`, the same
paths a co-located install bind-mounts.

An archive is keyed by its own sha256 under the session's epoch prefix, so a re-plan of unchanged
content writes nothing, the executor only ever holds URLs under its own prefix, and capture
retention sweeps the archives with the fenced epoch. A source is a copy: writes inside a session
stay in that session, because the archives land outside every capture root. A folder that cannot be
archived is left out with a warning rather than costing the session its start, and one archive is
capped at 64 MiB — the ceiling the daemon enforces too.

Both gate items that waited on the platform are in: sealantd declares the length of every upload it
asks a URL for, and lays down the plan's sources. With the source policy, upload length binding,
loopback service ports and an operator present, `MEND_TENANCY=multi` no longer refuses to start. It
requires sealantd 0.16.0 or newer, which the gate's detail names, and which the operator pins.
