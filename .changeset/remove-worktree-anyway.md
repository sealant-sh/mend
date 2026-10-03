---
"@sealant/mend": patch
---

A worktree whose change was never landed can now be removed from the web app and the CLI, in two
steps. The web app's worktree menu shows the store's refusal in its own words, with the files and
line counts not on origin, and offers "Remove anyway", which is the same removal with `force=true`.
Clear settled says how many worktrees it kept for that reason. `mend worktrees rm <name>` removes a
worktree from a terminal, prints a refusal as the server said it, and `--force` removes it anyway. A
worktree whose workspace is still saving is refused either way.
