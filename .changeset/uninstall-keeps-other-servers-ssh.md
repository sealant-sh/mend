---
"@sealant/mend": patch
---

`mend uninstall` removes only the `~/.ssh/config` blocks of the servers it removes: the one this
machine is signed in to, and with `--all` the local installation's. It finds the local one by its
alias or by its gateway, so a block set up before setup moved the URL is found too. Other servers'
blocks stay, and the plan names each block that goes and each that stays, with its host and port. An
older release's unscoped `Host mend-ws` block names no server, so uninstall no longer deletes it. It
says the block stays and how to delete it by hand. The key directory stays while a block that stays
signs with a key in it. `mend ssh setup` migrates that legacy block only when it points at the same
gateway; one for another server stays.

`mend ssh <session>` prints the exact `ssh ws-<workspace>@mend-ws-…` command for one session's
running workspace. No other output showed the workspace id, and the Docker container's name is a
different id that the gateway closes after its banner. `mend ssh setup` now points at it.

The uninstall plan no longer counts the server's own `mend` container as a session workspace, so "N
live sessions" is the number of sessions. An image Docker refuses is asked for again after the rest,
since removing another tag often removes it, so the last line no longer reports an image that is
gone. One that stays is named with Docker's reason.

`mend adopt` over https no longer says "your Mend key signed this clone". The Mend key signs ssh
remotes only, and adopt now says the clone went over https.
