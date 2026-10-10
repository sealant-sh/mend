---
"@sealant/mend": minor
---

`mend server setup` on a terminal with no flags asks its questions one at a time, in plain words:
how people reach this Mend (just this machine, your private network or Tailscale, or the public
internet with HTTPS), whether VS Code Remote-SSH reaches it from other machines, the T3 Code
gateway, the mirrors, and one organization or several. It reads Tailscale's name and address and
what Tailscale Serve forwards, where your domain resolves, and whether 80 and 443 are taken, and
says what it observed. On an existing install it shows what is saved and lets you change one thing.
It ends with what changes and the same command with flags, and applies on a yes.

Flags keep their meaning. `--declare <item>` now adds to the saved statements instead of replacing
them, `--undeclare <item>` takes one back, and `--origin none` clears the extra origins. A run with
flags on an existing install says what it changes. With no terminal and no flags, a fresh install is
refused and the message names the flags; `--yes` takes the defaults.
