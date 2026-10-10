---
"@sealant/mend": patch
---

`mend doctor` and `mend server setup` no longer tell you to raise Docker's `shutdown-timeout`
to 3600. dockerd's own shutdown already waits for each container's stop timeout, so the setting
changed nothing. The `docker` line now reports what a Docker stop waits for: the longest stop
timeout among the running containers, against the `TimeoutStopSec` of the systemd unit that runs the
daemon, or `live-restore on`. A workspace that would outlast the unit is named, with the session to
stop before you restart or upgrade Docker. Setup warns before it starts the containers. Until
sealant#361 bounded it at 60 s, a capture workspace asked for 3600 s. `systemctl stop docker` then
timed out, and the next `systemctl start docker` hung in "Restoring containers" for up to an hour.
The self-hosting, VPS and troubleshooting pages say what to do before a Docker upgrade, and how to
unstick a Docker that is already waiting.
