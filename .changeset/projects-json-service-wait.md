---
"@sealant/mend": patch
---

`mend projects --json` prints JSON (it printed the table). `mend service run --wait` exits 1 when
the port did not answer within the minute Mend waits, and the Service keeps running. A session id
given first on a `mend service run` line is no longer ignored when `--name` is absent.
