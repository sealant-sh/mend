---
"@sealant/mend": patch
---

The bundle runs Sealant 0.39.0-next.722 (sealant#361). A workspace container's own stop timeout is
now 60 s, so restarting or upgrading Docker with a live session finishes inside systemd's 90 s
instead of leaving Docker waiting in "Restoring containers" for up to an hour. A planned Stop still
gives the workspace its full grace, read from the container's `sealant.stop-grace` label. A
workspace that Docker's own stop kills keeps what it had not saved on its disk, and it is recovered.
Workspaces started before the upgrade keep their 3600 s until they stop: `mend doctor` names them.
The upgrade page and release notes say so.
