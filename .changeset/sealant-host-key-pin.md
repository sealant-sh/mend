---
"@sealant/mend": patch
---

The bundled sealant is 0.40.0-next.947. About 1 new server in 256 used to fail setup with its
container unhealthy, because the SSH gateway generated a host key it then could not read, and
crashed on every restart. A new host key now always reads, and a server already stuck that way
repairs itself on its next start: the gateway replaces the unreadable key and says so in its log.
Sealant's background jobs now also carry the trace of the request that queued them.
