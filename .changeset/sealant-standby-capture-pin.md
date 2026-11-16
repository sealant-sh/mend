---
"@sealant/mend": patch
---

Update the bundled sealant SDK and images to 0.40.0-next.923, which runs workspaces on sealantd
0.21.0-next.201.

- **A session that claimed a standby saves at its stop.** With hot sessions on, a session that
  started from a waiting standby could fail to save when stopped: its stop read `stopping`, then
  after 10 minutes `not saved · … pending · workspace kept`, and the only way out, **Discard unsaved
  and stop**, threw away its work (2 of 13 claimed standbys on our test server; on Boat the VM
  stayed up and billed meanwhile). It happened when the standby's sealantd was shipping its own
  queued capture at the moment of the claim: that capture survived the claim, the session's first
  save merged with it, and the result could never be uploaded. sealantd now never merges a session's
  capture with one staged before the claim, and drops the standby's leftover once it is no longer
  being shipped.
- **A session already kept this way is not repaired by the upgrade.** A workspace keeps the sealantd
  it started with, and the new one does not rewrite what the old one queued. Mend cannot open a
  shell or the terminal in it, read its files or resume it once its stop has begun saving. Before
  you discard such a session, copy out what you need from its workspace, which only an operator can
  reach on Docker or Kubernetes: see "A session that claimed a standby can stay not saved at its
  stop" in the known issues.
- **A standby already waiting before the upgrade is not replaced by it.** It keeps the old sealantd,
  and a session that claims it can still meet the old behaviour. To replace a project's standbys,
  set its hot sessions to 0, wait until they are gone, then set the count back.
- **A save already registered but still queued when a workspace's sealantd restarts is
  acknowledged.** Before, the next save after such a restart could be refused as a conflict, and
  nothing in that worktree saved again.
- **Every workspace image is built once more.** sealantd changed again, so after the upgrade the
  first session in each project on Boat waits for its image to be built again, as long as a first
  build takes. On Docker and Kubernetes, each blueprint's image is built again once; the steps
  before the runtime's own layer can still come from the build cache. On Boat, old images keep their
  saved snapshot slots until sealant's hourly pass removes them, a day after each was last used.
