---
"@sealant/mend": patch
---

The bundle pins Sealant platform 0.31.1 by digest and the SDK moves to 0.31.1; the workspace image
carries sealantd 0.15.1, the daemon with the fixes from the first capture-mode session on a cluster.
Tracked files win over `.gitignore`: the materialiser keeps `.git/index` across its sweep, so a
tracked file matching an ignore pattern (`tooling/typescript/core.json` under `core.*`) no longer
vanishes from the next worktree tree. Stored tips are seeded from refs alone, so a pack after boot
or replan carries every subtree the replacement executor needs instead of a negative it never
received. Packs and staging survive a long ship: an unchanged snap discards only objects no queued
capture still lists, a coalesced capture keeps the other class's dir objects, and the shipper mints
upload URLs 500 keys per call, matching Mend's per-call quota.
