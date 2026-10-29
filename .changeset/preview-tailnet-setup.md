---
"@sealant/mend": minor
---

`mend server setup --preview-tailnet` serves live previews on your tailnet, with no edge and no
domain: each at `https://mend-preview.<tailnet>.ts.net:<port>`, a port each from
`--preview-tailnet-ports` (default `20001-20016`), given when a preview is first opened, under one
Tailscale Service, `svc:mend-preview`. Setup reads the name from `tailscale status` on the machine
that runs Mend, and refuses when Tailscale is not running there, when MagicDNS is off, or when the
Docker engine is on another machine. Mend's own URL must be https first: serve its web port with
`tailscale serve --bg --https=443 http://127.0.0.1:3105` and add
`--url https://<this machine's MagicDNS name>`; setup now accepts that one https `--url` on a
loopback `--bind`, this machine's own `ts.net` name. The gateway's port is published on 127.0.0.1
only. A port goes to another preview once its own has had no open connection for 24 hours, and the
new preview's first open asks the browser to clear what the earlier one stored there. A server image
from before these previews is refused before anything is activated: upgrade the server first. Mend's
container cannot reach `tailscaled`, so setup prints the `tailscale serve` command for each port and
never runs it: on the run that turns previews on, with the Service's endpoints and the six things to
turn on in Tailscale; on later runs, only the ports to add or take off, against what
`tailscale serve status` showed when it could be read, else against the ports saved last time. Setup
says when it observes Funnel on for one of these ports. Refused with `--exposure public`.
`--preview-tailnet` replaces a preview domain and `--preview-domain` replaces the tailnet;
`--no-preview-tailnet` turns previews off and prints the commands that take their ports off.
`mend operator exposure` lists `preview-gateway` as open until you check from a device on the
tailnet and one outside it, then `--declare preview-gateway`.
