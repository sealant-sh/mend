---
"@sealant/mend": patch
---

Serve current co-located worktree images, HTML, PDF, video and audio in t3code through device-bound
asset URLs. Stream contained file descriptors with byte ranges, recheck project access and device
revocation, and apply the same expiring grant policy to chat images. A page of images waits its turn
instead of failing, and a stalled reader frees its slot after 30 seconds. Two new budgets bound open
raw reads (`MEND_BUDGET_ACCOUNT_RAW_READS`, `MEND_BUDGET_RAW_READS`). The edge Caddy that
`mend server setup` writes keeps asset URLs and raw read paths out of its logs. Captured and
checkpoint raw reads remain unavailable.
