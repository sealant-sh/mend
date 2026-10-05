---
"@sealant/mend": patch
---

Removing a worktree no longer deletes the repositories its sessions added with `mend repo add`
without asking. Their files and history are saved only inside that worktree, outside its change, so
removal now refuses for them as it does for a change that was never landed, naming each repository,
and offers **Remove anyway** (`force=true`, `mend worktrees rm --force`).
