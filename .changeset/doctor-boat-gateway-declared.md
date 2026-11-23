---
"@sealant/mend": patch
---

On a server set up with `--no-boat-resources`, `mend doctor` now reads the Boat resource gateway as
off by the server's setting (`· boat gateway off · declared`, with how to turn it on) and exits 0
when nothing else fails, as `mend server status` does. Before, it marked the gateway `✗`, told you
to restart a worker that was fine, and exited 1. A worker that should run the gateway and reports
none still reads `✗`. Doctor needs a server of this version or later to know the setting.
