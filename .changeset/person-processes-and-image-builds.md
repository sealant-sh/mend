---
"@sealant/mend": patch
---

While a workspace gets ready, the session line now says where it stands, as Sealant reports it:
"queued · waiting for a worker", "building the workspace image · step 3/12", then "booting". A first
launch after an update can take many minutes to build its image without the launch giving up, and
when a build stops making progress or runs past its limit the session says so, with the step it was
on. With `MEND_HARNESS_LAYOUT=person`, the default, each person's processes now run as their own
user on Sealant's routes for it: a workspace runs per person only when Sealant says it can and the
workspace's image says it can too; otherwise a new worktree runs as one person and says why, and a
worktree already saved per person is refused with the reason. When Sealant refuses to start a
process as a person, the session says why in plain words, and nothing is ever started as anyone
else. With `MEND_HARNESS_LAYOUT=shared`, nothing changes but the launch line.
