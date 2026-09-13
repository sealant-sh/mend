---
"@sealant/mend": minor
---

Sessions run on the capture store by default (`MEND_SESSION_STORE=captured`): a session's work
product is a chain of captures in a bucket, and the executor that made it is disposable. The Docker
bundle (`mend server setup`) ships Garage as that bucket, single-node on its own ownership-labelled
volume `mend-garage`, laid out once at setup; an install from before the capture store is upgraded
in place, and a worktree made before captures is backfilled from its files at first launch. Projects
gain an install command and a per-project dependency cache, so a fresh executor restores
`node_modules` and its kin instead of installing them again. The review header names the capture the
bytes were observed at. The bundle pins Sealant platform 0.31.0 by digest, which carries the
`capture` workspace source, the Compose-network attach for workspace containers, runtime-observed
exits and `capture.flush`/`capture.replan`, with sealantd 0.15.0 inside the workspace image.
