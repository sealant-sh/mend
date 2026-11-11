---
"@sealant/mend": patch
---

Mend's helper runs in Boat sessions. A Boat workspace is an Ubuntu VM whose `/run` is mounted
noexec, so the helper Mend wrote to `/run/mend/bin` could not run: Claude reported the mend MCP
server failing with `EACCES`, and Claude's hooks, Codex's hooks, `mend service`, screens and git's
transport over Mend failed the same way. A workspace that mounts nothing now gets the helper written
to `/usr/local/lib/mend/bin`, with `/run/mend/bin` linking to it, so every path that names
`/run/mend/bin` keeps working.
