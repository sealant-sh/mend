---
"@sealant/mend": patch
---

With `MEND_HARNESS_LAYOUT=person`, the default, per-person workspaces now work end to end: when a
workspace starts for a worktree saved per person, Sealant restores each person's saved conversations
as their own files and gives the worktree to everyone working in it, so each person's processes can
edit it and use `sudo`. If the workspace image or the deployment cannot do that (an image that does
not report it, or Kubernetes, where no one's `sudo` works), the launch is refused before anything
runs, with the reason, and the next launch of a new worktree on that image runs as one person. Ready
workspaces kept warm for fast starts are only used for sessions that run as one person. With
`MEND_HARNESS_LAYOUT=shared`, nothing changes.
