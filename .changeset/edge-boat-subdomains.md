---
"@sealant/mend": minor
---

Mend's TLS edge can now serve the two addresses Boat VMs connect back to, each on a name of its own
on port 443. Give setup `--edge mend.example.com` with
`--session-endpoint-url https://session.mend.example.com` and
`--blob-store-public-url https://files.mend.example.com`: the edge gets a certificate for each name
and sends session traffic to Mend and saved work to its bucket. A public server with Boat then needs
only ports 80 and 443 open, and no Tailscale or proxy of its own. Addresses with a port keep today's
behaviour, forwarded by your own proxy.
