---
"@sealant/mend": minor
---

`mend doctor --bundle` collects what a maintainer asks for one output at a time into one tar.gz:
this CLI and its environment, the doctor lines, the server's health, the local server's
configuration (compose file, `.env` key names only), Docker's version, info, contexts, the Mend and
workspace containers with their inspect facts, the local server's container logs, the running
workspace containers' logs, every session with its processes, exit codes, argv and recorded terminal
output, the connected accounts, and the versions and paths of claude, codex, gh, git and docker.
Each part is collected on its own: one that fails leaves a `<name>.error.txt` in the bundle. One
redactor runs over every file before it is written, the archive is mode 0600, and the command says
so: it still contains logs and configuration, so read it before sharing. `--out <path>` and
`--tail <n>` (lines per log and per record, default 500) are the options.
