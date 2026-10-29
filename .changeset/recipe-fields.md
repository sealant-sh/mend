---
"@sealant/mend": minor
---

`mend.toml` recipes take `cwd`, `env`, `ready`, `host`, `address` and `depends`, and the file takes
a `[preview]` table. Mend 0.37 is the first server that reads them; an older server ignores them and
runs the `command` at the repository root. A recipe runs in `/workspace/repo/<cwd>` with its `env`,
then `PORT`, then `MEND_PREVIEW_URL` when its preview has an address.
`ready = { http = "/", timeout = "2m" }` waits for any HTTP answer, over TLS for an `https` Service,
and the background probe keeps that rule. `host = "preserve"` keeps the preview's host on its
requests. `address = "docker"` marks a port Docker publishes, which Mend dials port-scoped.
`depends` starts the recipes it names first, and waits for one already running to answer. A start
runs to its end on the server whatever happens to its request; `mend service run <name> --wait`
follows it dependency by dependency (`GET /sessions/:id/services/starts/:startId`). A bad key
refuses that recipe alone and names the key, and the file's other recipes still run; a key Mend does
not read is ignored and listed. `GET /sessions/:id/declarations` answers the file read whole. A
restart replays the attempt's command, directory and environment rather than the file.
`mend service init` proposes `browserScheme`, `cwd`, `address` and `[preview]`.
