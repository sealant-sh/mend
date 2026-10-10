---
"@sealant/mend": patch
---

Fixes from the fresh-install test on stock Ubuntu 24.04:

- `mend run -- bash` (or `sh`, `zsh`, `fish` and the other shells, given no script and no `-c`) is
  refused before anything is created. An attached `mend run` shows output and sends no keys, so the
  shell would sit waiting for input. The refusal points to **Open a shell** on the web,
  `mend shell`, or `mend run --detach` followed by `mend attach`. The line a Ctrl+C prints now also
  names `mend stop <id>` as the way to end the command.
- On Node 22 the CLI installs and runs without warnings. The terminal dashboard's renderer is pinned
  to the version Mend is tested with, which declares no Node engine, so npm no longer prints
  `EBADENGINE`. The `node:sqlite` ExperimentalWarning is no longer printed. The CLI, `install.sh`
  and the docs all require Node.js 22.13 or newer, the first 22 release with `node:sqlite`
  unflagged. An older Node is refused in one line. The dashboard still needs Node 26.
- A settled session with no run no longer reads "recording: off — launched before the platform's
  supervised path". A failed launch says it failed before a run started, and any other such session
  says no run started.
