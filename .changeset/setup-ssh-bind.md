---
"@sealant/mend": patch
---

`mend server setup --ssh-bind <ip>` publishes workspace SSH on its own address. With `--edge`, the
web port stays on loopback and the edge carries HTTPS only, so until now the SSH gateway stayed on
loopback too and Remote-SSH from another machine (VS Code on a laptop, `mend ssh`) could not
connect. `--ssh-bind 0.0.0.0`, or a private address, publishes it; the setting is kept across reruns
and upgrades, and naming the `--bind` address takes it away. A release whose compose asset cannot
honour it is refused rather than left on loopback.

A rerun with `--port` now moves a saved non-local `--url` that names the old port to the new one, as
it already did for `http://localhost`; before, `APP_URL` kept pointing at a port nothing published.
