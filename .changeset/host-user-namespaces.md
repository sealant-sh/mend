---
"@sealant/mend": patch
---

On a Docker host that refuses unprivileged user namespaces (Ubuntu 23.10 and later, by default), no
session can start. `mend server setup` now says so as its last line and `mend doctor` reports it on
a `workspaces` line, each with the command that allows them.
