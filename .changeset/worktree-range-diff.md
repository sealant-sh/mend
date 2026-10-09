---
"@sealant/mend": minor
---

`GET /api/worktrees/:id/diff?from=&to=` renders a slice of a worktree's checkpoint chain: from one
checkpoint (or, with no `from`, the worktree's base) to a later one, with each file's status and
line counts, and `whitespace=ignore` as the review diff takes it. Both ends are immutable commits,
so a slice never moves. It reads through the same worktree reads as the change and review diffs, and
anyone who can see the worktree may read it; to anyone else it is not there. A checkpoint not in the
worktree's chain answers 404 naming it, and a slice that runs backward is refused. The t3code
gateway reads one turn's work with it (ADR 0012).
