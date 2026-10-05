---
"@sealant/mend": patch
---

Workspaces run sealantd 0.20.0-next.142, the sealantd Sealant 0.39.0-next.683 pins by digest. It
sends each upload's SHA-256, pack indexes included, so a Stop on Garage can seal without waiting for
its upload links to expire. No harness login is captured with the harness home, so the next session
in the worktree never inherits one. A final save and a restore use every core, and the `socat` relay
comes over HTTPS, checked against a pinned checksum.
