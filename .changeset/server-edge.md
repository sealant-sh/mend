---
"@sealant/mend": minor
---

The packaged server knows its edge and its posture. `mend server setup --edge <host>` runs the Caddy
TLS edge in front of Mend: the repository's `compose.edge.yaml` and `Caddyfile` are written into the
install's generation beside `compose.yaml`, `MEND_EDGE_HOST` goes into `server.env`, the browser
origin becomes `https://<host>` and Mend's own port stays on loopback. `--exposure` and `--tenancy`
declare the posture the same way, and with `multi` or `public` the multi mode gate's settings follow
(`MEND_SOURCE_POLICY=tenant`, `MEND_CAPTURE_REQUIRE_SIZES=true`, and for `public`
`MEND_URL_BEARERS=refuse`) through a `compose.posture.yaml` that reads every value from
`server.env`. Every `start`, `restart` and `upgrade` runs the generation's overlays with its
`compose.yaml`, so an upgrade never drops the edge or the posture; `--no-edge` takes the edge away.
`mend server status` reports the edge host, whether its container runs and whether Caddy's data
holds a certificate, the exposure and tenancy declared beside what the running server observes, and,
when this machine is signed in as the operator, every item of both gates.
