---
"@sealant/mend": patch
---

`mend handoff` without a prompt now waits for the hold when the server answers before it is up, as
it does while a Boat VM boots. It follows the session for up to 3 minutes, says it is waiting, then
prints `✓ held · idle, no agent`, or `! not held · failed · …` with the `mend resume … --with shell`
command, as it does on Docker. A failed hold on Boat is no longer silent. Ctrl-C stops the watching,
not the hold, and says so.
