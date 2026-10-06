---
"@sealant/mend": patch
---

With the Sealant 0.39.0 prerelease, every workspace image carries pi beside Claude Code, Codex and
opencode; a Stop is recorded once the executor has ended, before its remains are removed; a run's
changes are read from a refreshed copy of the index; and a launch's execs and a workspace's
readiness are read back sooner. The bundle takes the Sealant API, worker and SSH gateway from the
`-next` images, pinned by digest.
