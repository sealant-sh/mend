---
"@sealant/mend": patch
---

The packaged server's Sealant worker starts up to four workspaces at once, and stops up to four,
instead of one at a time. A launch held the only slot until its executor was ready, the restore of a
large save included, so on a box shared by several people and agents a session could wait half a
minute behind another before its own start began. `WORKSPACE_BUILD_QUEUE_PREFETCH` in the server's
environment still sets the number.
