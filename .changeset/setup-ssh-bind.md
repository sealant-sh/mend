---
"@sealant/mend": patch
---

`mend server setup --ssh-bind <ip>` publishes workspace SSH on its own address. With `--edge`, the
web port stays on loopback and the edge carries HTTPS only, so until now the SSH gateway stayed on
loopback too and Remote-SSH from another machine (VS Code on a laptop, `mend ssh`) could not
connect. `--ssh-bind 0.0.0.0`, or a private address, publishes it; the setting is kept across reruns
and upgrades, and naming the `--bind` address takes it away. A release whose compose asset cannot
honour it is refused rather than left on loopback.

SSH published that way is its own item of the public exposure gate, `workspace-ssh`. The server
reads where it is published (`MEND_SSH_PUBLISHED`), reports loopback as observed, and anything else
as open until the operator states who reaches it (`MEND_EXPOSURE_DECLARED`, which
`mend server setup --declare <item>` now writes). A `public` start waits for that statement, and
setup refuses `--exposure public` with SSH beyond loopback until `--declare workspace-ssh`. Setup
also says what it observed from its own machine: each address it tried, and whether an SSH banner
answered.

A rerun with `--port` now moves a saved plain-http `--url` that names the old port explicitly (the
LAN or tailnet case) to the new one, as it already did for `http://localhost`; before, `APP_URL`
kept pointing at a port nothing published. An `https` URL, or one whose port is implicit, is an
endpoint in front of Mend and stays as it was.
