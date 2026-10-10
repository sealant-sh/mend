---
"@sealant/mend": patch
---

`mend service run --wait` waits through a slow start. It exited 1 whenever the port had not answered
within the minute Mend holds a start, while the Service kept building. It now keeps waiting while
the Service's process runs and its port has not answered, up to `--timeout <duration>` (default
`10m`), and the exit status says what was observed: `0` the port answered, `1` Mend refused the
start, `2` the Service's process ended first (with its status and exit code), `3` the session's
workspace ended first, `124` still starting at the timeout.

`mend service list` prints each Service's current attempt's process id, and `--json` prints the
Services as JSON. `mend logs --service <name-or-id>` reads a Service's current attempt, and
`mend logs --process` takes a Service's id or name too. A Service with no attempt yet is refused
with a line that says why nothing is recorded. `mend wait --timeout` takes a duration (`90`, `90s`,
`5m`, `1h`), as `mend service run --timeout` does.
