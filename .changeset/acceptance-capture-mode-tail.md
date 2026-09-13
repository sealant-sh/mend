---
"@sealant/mend": patch
---

The packaged acceptance proves the recorded change from the capture store. Under captures the
session's branch and worktree live on the executor's own disk and its commits reach Mend as captures
in the bucket and Postgres, so the old `git --git-dir=<store>/repo.git rev-parse <branch>` inside
the Mend container answered "unknown revision" and failed the v0.27.1 release run. The stage now
reads the worktree's checkpoint chain and a Review slice whose base-to-checkpoint patch the git
runner serves from packs, through the public API, and every lifecycle stage (setup rerun, restart,
stop/start, upgrade) checks that chain and patch survive unchanged. The store volume and the
executor's disk are never inspected.
