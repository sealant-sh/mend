---
"@sealant/mend": minor
---

`mend run` works for scripts. It prints the command's output (it printed record summaries such as
`pty-out 9B @0`) and exits with the command's exit code. Its own lines go to stderr, so
`out=$(mend run -- git log -1)` holds the command's output alone. `--detach` returns once the
command runs, and `--json` prints the session and process ids (and, without `--detach`, how the
command ended).

A command the platform would refuse is refused before anything is created. The platform takes at
most 64 words, none empty and none starting or ending with whitespace, so a `bash -lc` script that
starts with a newline used to create a session and then fail its launch.

New: `mend logs <session> [--follow]` prints any session's recorded terminal output, and
`mend wait <session> [--timeout <s>]` returns once its command ended, with its exit code (124 on
timeout).
