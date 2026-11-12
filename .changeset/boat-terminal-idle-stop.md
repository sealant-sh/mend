---
"@sealant/mend": patch
---

On Boat, terminal sessions stop after 15 idle minutes, as agent sessions already do. Each Boat
session is a paid VM, and a shell left open kept its VM running. A terminal session is idle when no
client is attached to it, nobody typed into it and it printed nothing new for
`MEND_PROTOCOL_IDLE_STOP_MINUTES` (15 by default; 0 turns it off). Containers and background
processes in the workspace do not count. It stops the way Stop does, saves its work first, reads
`idle · stopped after 15 min · resume to continue` and can be resumed. On Boat, a shell tab left
open in a conversation session no longer keeps it up by itself: it holds the session only while it
is in use the same way. Sessions on Docker are unchanged.
