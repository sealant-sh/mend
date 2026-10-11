---
"@sealant/mend": patch
---

The guided `mend server setup` no longer suggests an SSH tunnel. With no private network on the
machine it offers a tailnet or public HTTPS. With the T3 Code gateway on loopback, this machine's or
behind the edge on a public install, it gives the Tailscale Serve command that reaches the gateway
from the tailnet whenever Serve already forwards Mend's port, and says so when Serve already
forwards the gateway's.
