---
"@sealant/mend": minor
---

A workspace SSH key can now be removed. `mend ssh keys` lists every key your account registered,
from every machine, and marks the one this machine offers; `mend ssh keys remove <fingerprint>`
removes one, and Settings → Workspace SSH lists the same keys with a Remove action. The gateway
looks a key up on every new connection, so the next connection with a removed key is refused; a
connection already open stays open until it ends. You see and remove only your own keys. Removing a
member removes all of theirs, and `mend uninstall --home` removes this machine's key before it
revokes the terminal's device token. The organization's audit log records each key registered and
removed.
