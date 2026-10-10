---
"@sealant/mend": patch
---

While a workspace gets ready, the session line now says where it stands, as Sealant reports it:
"queued · waiting for a worker", "building the workspace image · step 3/12", then "booting". A first
launch after an update can take many minutes to build its image without the launch giving up, and
when a build stops making progress or runs past its limit the session says so, with the step it was
on.
