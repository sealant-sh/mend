---
"@sealant/mend": patch
---

A session started in a worktree whose previous session is still saving now waits for that save
instead of failing with `worktree leased · … saving before it ends`. It reads
`starting · waiting · the previous session in this worktree is saving`, then starts once the
previous executor's end is confirmed. It is refused only after 30 minutes
(`MEND_LAUNCH_LEASE_WAIT_SECONDS`), and a stop while it waits launches nothing.
