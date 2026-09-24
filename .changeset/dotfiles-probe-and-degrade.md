---
"@sealant/mend": patch
---

Saving a dotfiles repository now runs the launch's own clone and archive once, with the same limits
and the same Git environment. A repository the server cannot clone, a branch or subdirectory it does
not have, or a tree over the limits is not saved, and the save shows the reason. At launch, a
dotfiles source that fails (the repository clone or the synced snapshot) no longer fails the
session: the workspace starts without that source, the other source still applies, and the session
records what was left out. The session page shows it, for example
`dotfiles · repo not applied · <reason>`. Standby workspaces behave the same way. The server's clone
of a dotfiles repository runs quietly, so a failure reason no longer includes the server's temporary
directory.
