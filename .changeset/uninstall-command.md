---
"@sealant/mend": minor
---

`mend uninstall` removes what Mend put on a machine. It asks for a scope when none is given:
everything, the server only, or this machine's files only (`--all`, `--server`, `--home`; `--yes`
skips the confirmation). The plan is printed before anything goes, and the server scope requires
typing `delete`: it takes the Compose installation down with its volumes, removes the external store
and control volumes only when their ownership label matches this installation, untags the release
image, and deletes the private configuration's identity, generations and backups. The home scope
revokes this terminal's device token first, then removes `cli.json`, the workspace SSH key and the
managed `~/.ssh/config` block. Files Mend did not create are listed and kept; workspace containers
are named with the command that removes them, never removed.
