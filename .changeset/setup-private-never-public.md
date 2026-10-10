---
"@sealant/mend": patch
---

`mend server setup` no longer offers a public address as a private network. Under "my private
network or Tailscale" it offers only the tailnet, LAN or VPN addresses (RFC 1918, ULA) and
carrier-grade NAT space, and pre-selects one of them. A public address is said as observed and left
out, and so is "every address" when the machine holds a public one. On a VPS whose only address is
public, setup says so and installs on this machine, with the ways to reach it from elsewhere: a
tunnel, Tailscale, or public HTTPS. Before, Enter there published a fresh install on the public
address as `private`, with registration open to whoever reached it first. A fresh install now
refuses `--bind` on a public address without the edge, with flags too. On an existing install, a run
that publishes Mend's port or workspace SSH on a public address while the exposure is not public
says so beside the declared exposure. A Tailscale Serve name with Funnel on is said to be public and
offered as a browser origin with No as the answer, and not at all on a fresh install. Moving the web
to another address on a rerun keeps workspace SSH where it was published by default, instead of
moving it along.
