---
"@sealant/mend": patch
---

A session and its run settle together. A session settled by any path, a failed launch, a lost
executor, the sweep after a restart, now settles the run it left open with the same outcome and
summary. Startup and the lease reaper settle a run left `running` under a session that had already
settled, once, with the session's words. A resume of such a session no longer fails on the
one-active-run index with an unhandled error: the stale run is settled first and the resume goes on,
and a run that is still live is refused in words, `a run of this session is still open`, and never
settled.
