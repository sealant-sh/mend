---
"@sealant/mend": minor
---

`mend run` works for scripts. It prints the command's output (it printed record summaries such as
`pty-out 9B @0`) and exits with the command's exit code. Its own lines go to stderr, so
`out=$(mend run -- git log -1)` holds the command's output alone. `--detach` returns once the
command runs, and `--json` prints the session and process ids (and, without `--detach`, how the
command ended).

A command the platform would refuse is refused before anything is created: more than 64 words or 1
MiB, a word over 131,071 bytes, a program with leading or trailing whitespace, or a NUL byte. An
argument may be empty, start with a newline or span lines, so a `bash -lc` script that starts with a
newline runs (it used to create a session and then fail its launch).

New: `mend logs <session> [--follow]` prints any session's recorded terminal output, and
`mend wait <session> [--timeout <duration>]` (`90`, `90s`, `5m`, `1h`) returns once its command
ended, with its exit code (124 on timeout).

`mend run` and `mend logs` give stdout no more than a slow reader takes and exit only once it has
all of it, waiting at most 5 seconds at exit for a reader that takes nothing. A signal stops
watching with exit 128 + its number (130 for Ctrl+C) and puts the terminal's modes back, for
`mend logs` too. Output that could not be delivered in full fails the run (exit 1).
`mend wait --timeout` bounds every read and retry, never counts a previous process's end while a
resume starts, and takes `--process <id>`.
