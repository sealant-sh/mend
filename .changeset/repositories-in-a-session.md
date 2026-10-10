---
"@sealant/mend": minor
---

Any project of the store can be added to a running session from inside its workspace:
`mend repo add <project>` puts a worktree of that project at `/workspace/repos/<name>`, on a branch
of its own for the session, and `mend repo list` and `mend repo projects` show what is there and
what can be added. Each repository is a worktree of its project, so it keeps its own change. On a
capture-mode server the files are saved with the main repository's captures and come back on a
resume; the session page lists each repository with its state and how it is saved. The review of a
repository's own change follows once the capture daemon carries repository roots
(docs/adr/0011-repositories-in-a-session.md). Removing a worktree that holds repositories refuses,
naming each, and offers **Remove anyway** (`force=true`, `mend worktrees rm --force`). A private
project can be added only from a session in another private project of yours; the refusal says why.
