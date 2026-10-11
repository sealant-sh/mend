---
"@sealant/mend": patch
---

A session whose workspace image build fails now ends `failed`, with the build's reason, and frees
its worktree. Before, Mend read the failed workspace as an executor kept for recovery and asked
Sealant to stop it, which Sealant refused as "still launching" every time, so the session read
`stopping · saving` until the machine was wiped. A launch that never ran an executor (no runtime, no
drain) has nothing on any disk to save. A workspace whose executor ran is still kept.

A session stopped while its image builds reads `stopped` from then on, not `starting` while the
build runs on, and the build failing afterwards no longer rewrites it as `failed`.
