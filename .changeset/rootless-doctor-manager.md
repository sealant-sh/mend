---
"@sealant/mend": patch
---

Suggest the user systemd manager when an observed rootless Docker service needs a longer stop
timeout. Doctor and setup now show `systemctl --user edit docker.service` for that service.
