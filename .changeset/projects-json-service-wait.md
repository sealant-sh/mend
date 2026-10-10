---
"@sealant/mend": patch
---

`mend projects --json` prints JSON (it printed the table). A session id given first on a
`mend service run` line is no longer ignored when `--name` is absent. `mend service run --wait`
opens no tunnel (it returns), refuses a recipe that declares only a port, and gives up with 124 when
the server gives no answer within 90 seconds, counted from its first request.
