---
"@sealant/mend": patch
---

`mend uninstall` leaves a machine that can reinstall. The plan lists live sessions and their
workspaces. After the same `type delete`, uninstall stops them and removes each with its Docker
service, their volumes and its network, then the server. The report names each volume and network
that went and each that did not. The `mend-store` anchor and the identity go last, only once
everything else has. If Docker refuses something, uninstall keeps them and writes what is left to
`uninstall-left.json`, so a second run finishes the job and `mend server setup` reinstalls over it.
With no configuration here, volumes carrying Mend's installation label and no anchor are an earlier
install's leftovers: setup's refusal now points at `mend uninstall --server`, which lists and
removes them.

With Docker stopped, `--server` and `--all` refuse before touching anything. They no longer remove
the sign-in and ssh key first and leave them registered on a server that still exists. `--all`
removes the server first, then asks the signed-in server, when it is another one, to forget this
machine's key and device, and only then removes local files. A sign-in to the server being removed
is not revoked: its token went with the server, and `--server` clears it from `cli.json`.

`--all` also offers the images Mend pulled and built, with their size, and removes
`/etc/sysctl.d/60-mend-rootless-docker.conf` when setup wrote it, putting back the setting it
replaced. Docker's build cache gets its own question. The last line names what is still here, the
CLI itself included (`npm uninstall -g @sealant/mend`), instead of "Mend is gone". Any answer to the
confirmation other than the word removes nothing, says what was read and exits 1.
