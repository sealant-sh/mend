---
"@sealant/mend": minor
---

A session's workspace now has a memory limit, so one session can no longer use all of the server's
memory and stop it for everyone. On the Docker install each workspace gets half of the machine's
memory (at least 2 GiB, at most 16 GiB) and its Docker service a quarter (at least 1 GiB, at most 8
GiB). When a workspace reaches its limit, the kernel stops a process inside it, and the turn it
happened in says "The workspace hit its memory limit" and what was stopped: the agent, or a process
in the workspace, most likely a command the agent ran. When the agent itself was stopped, the
session's line says so instead of an exit code. `mend server setup --workspace-memory` and
`--workspace-docker-memory` take `auto`, `none` or a size such as `6g`.
