---
"@sealant/mend": patch
---

Sign-in for a Mend on a Mac mini, reached from other machines. A server clock that disagrees with
yours no longer breaks it. After a Mac sleeps, OrbStack's VM clock can run hours behind, and
`mend login`, the VS Code extension and the authorize page compared the server's `expiresAt` with
their own clock, so the request read as expired the moment it opened. The server now also sends
`expiresIn` (seconds left, by its own clock) and clients count down from when the answer arrived.
Against an older server they read `expiresAt` against its Date header. The server still judges
expiry by its own clock alone. `mend doctor` says when the server's clock is more than two minutes
off this machine's (`this server's clock is 116 min behind this machine's`), with what resets it. On
a Mac with a server installed, it also says when the Mac still sleeps on its own (`pmset -g`):
OrbStack and Docker Desktop pause their VM while it sleeps. The Mac mini guide says to turn
automatic sleep off and Wake for network access on.

`mend login` over SSH, or on Linux with no display, prints the link and code and opens no browser.
Before, it opened the page on the far machine's screen. `--open` and `--no-open` decide outright.

In VS Code, polling no longer waits for the "open the external website?" dialog, which can sit
behind other windows on Linux. The sign-in shows the link and code with "Copy link" and "Paste a
device token instead". The plain-http warning is shorter, says nothing over Tailscale (by address or
`.ts.net` name), and says "anyone on this local network can read the token" on a LAN. "Open in VS
Code" is in the session row's right-click menu too.

The authorize page names the client asking: "Authorize VS Code?" for the extension, "Authorize this
terminal?" for `mend login` (migration 0128 keeps which client opened a request). A guided
`mend server setup --context orbstack` now puts `--context orbstack` in its "Same as:" command.
