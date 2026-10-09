---
"@sealant/mend": patch
---

`mend projects --json` prints JSON (it printed the table). `mend service run --wait` exits 1 when
the port did not answer within the minute Mend waits, and the Service keeps running. A session id
given first on a `mend service run` line is no longer ignored when `--name` is absent.

The CLI no longer prints a repository URL's credentials: an origin adopted as
`https://oauth2:TOKEN@github.com/...` reads without the token in JSON, tables and messages. `--wait`
opens no tunnel (it returns), refuses a recipe that declares only a port, and gives up with 124 when
the server gives no answer within 90 seconds.
