---
"@sealant/mend": patch
---

`mend uninstall --server` removes every per-workspace Docker network Sealant creates for an
installation's live or leftover workspaces (`-network`, `-egress`, `-isolated` and `-proxy-egress`),
not only `-network`. Before, uninstalling while a session was running left its egress and
egress-proxy networks behind on the Docker daemon.
