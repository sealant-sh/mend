---
"@sealant/mend": minor
---

`mend handoff ["prompt"]` copies the branch in your checkout into a new session: the commits ahead
of the merge base with the default branch, the staged, unstaged and untracked files. The checkout is
not written to. Gitignored files, `.env*` files, files over the server's file limit and files with a
git filter attribute stay behind, each named, and a `.env*` file inside a commit ahead is named with
its commit. With a prompt the agent starts on it and the command returns; without one the workspace
is held with no agent. The checkout's origin must be the project's origin, an unadopted origin is
offered for adoption (`--yes` without a terminal), and an older server is named with its version
before anything is built. The dashboard and `mend sessions` say `handed off from <machine>` on the
worktree and its sessions.
