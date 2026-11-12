---
"@sealant/mend": patch
---

Sessions on Boat start on a host that refuses unprivileged user namespaces (Ubuntu 24.04's default).
Mend checked the host's kernel before every launch and refused with
`the server's host refuses user namespaces · no workspace can start`, but a Boat session runs in a
Boat VM whose image carries its own Docker engine; the host's Docker only builds images and runs
resources, which need no user namespaces. A session whose worktree runs on Boat now skips that
check, and Docker sessions keep it. `mend server setup` no longer asks "Allow them now?" or says
sessions cannot start when this install's sessions run on Boat; when Boat is set up and the guide
can still move sessions to it, the question waits until the answers say where sessions run. The
machine view, `mend doctor`'s workspaces line and `mend server status --json` say nothing of the
host's user namespaces while new sessions run on Boat.
