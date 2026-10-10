---
"@sealant/mend": minor
---

`GET /api/worktrees/:id/contents` reads a worktree's files: one file with `path=` (as the worktree
stands, or at one of its checkpoints with `at=`), at most 1 MiB of it, its size, and whether it is
binary; or, with `query=`, the lines that match a search across the worktree as it stands, untracked
files included and ignored ones not, with `caseSensitive`, `wholeWord`, `regex` and a `limit` up
to 500. A path must stay inside the worktree: `..`, an absolute path and `.git` are refused, and a
symlink that leads out of the worktree reads as nothing there. The file is opened directory by
directory without following a link, and what was opened is checked to be inside the worktree before
it is read, so a directory swapped for a link while it is read never yields bytes from outside. A
search is bounded as a whole (its limit, 4 MiB of output, 10 seconds) and answers what it found with
`truncated`, each line cut at 2,000 characters: a large file never fails it. Anyone who can see the
worktree may read it; to anyone else it is not there. The t3code gateway shows files and searches
them with it (ADR 0012).
