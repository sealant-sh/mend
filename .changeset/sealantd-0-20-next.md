---
"@sealant/mend": patch
---

With sealantd 0.20, workspaces send each upload's SHA-256, pack indexes included, so a Stop on
Garage can seal without waiting for its upload links to expire. No harness login is captured with
the harness home, so the next session in the worktree never inherits one. A final save and a restore
use every core, and the `socat` relay comes over HTTPS, checked against a pinned checksum.
