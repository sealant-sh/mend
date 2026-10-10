---
"@sealant/mend": patch
---

`mend service run --wait` waits through a slow start. It exited 1 whenever the port had not answered
within the minute Mend holds a start, while the Service kept building. It now keeps waiting while
the Service's process runs and its port has not answered, up to `--timeout <duration>` (default
`10m`), and the exit status says what was observed: `0` the port answered, `1` Mend refused the
start, `2` the Service's process ended first (with its status and exit code), `3` the server no
longer has the session, `124` still starting at the timeout. The wait judges only the process its
own start began: the start sends an id the server stamps on that attempt, so another client's start,
restart or stop never decides it. A server older than the CLI stamps none; there a start an edge cut
is not followed, and a command that exits inside the server's minute reads as the refusal the server
answers with (exit `1`).

`mend service list` prints each Service's current attempt's process id, and `--json` prints the
Services as JSON. `mend logs --service <name-or-id>` reads a Service's current attempt, and
`mend logs --process` takes a Service's id or name too: a full id names its Service before any name,
and a name two Services carry is refused with both ids listed. A Service with no attempt yet is
refused with a line that says why nothing is recorded. `mend wait --timeout` takes a duration (`90`,
`90s`, `5m`, `1h`), as `mend service run --timeout` does; a bare number is seconds as before, `.5`
included.

A reader that closes the pipe early (`mend service list | grep -q web`, `| head -1`) no longer kills
the CLI with an unhandled EPIPE and a stack trace: every command exits 0, quietly. `mend run` and
`mend logs` still fail when their command's output could not be delivered.
