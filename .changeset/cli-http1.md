---
"@sealant/mend": patch
---

The CLI speaks HTTP/1.1 to the server. Node 26's built-in `fetch` negotiates HTTP/2 and puts the
whole process on one connection, and on an instance behind an edge that connection could wedge once
the dashboard's or the tunnels' event stream opened: a dashboard launch sat at `starting` without
reaching the server, and `mend attach` timed out waiting for its upgrade ticket. Each request now
has its own connection, so one cannot hold up another.
