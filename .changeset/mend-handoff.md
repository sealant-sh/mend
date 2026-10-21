---
"@sealant/mend": minor
---

`mend handoff ["prompt"]` copies the branch in your checkout into a new session: the commits ahead
of the merge base with the default branch, the staged, unstaged and untracked files. The checkout is
not written to. Gitignored files, `.env*` files, files over the server's file limit and files with a
git filter attribute stay behind, each named. A `.env*` file inside a commit ahead is named with its
commit, and an edit hidden by `assume-unchanged` or `skip-worktree` travels and is named with its
bit. With a prompt the agent starts on it and the command returns; when it does not start, the CLI
names the `mend <harness> --project … --worktree … '<prompt>'` that sends the same prompt. Without a
prompt the workspace is held with no agent. The checkout's origin must be the project's origin (same
host, port and path; path case counts except on github.com), an unadopted origin is offered for
adoption (`--yes` without a terminal), and an older server is named with its version before anything
is built. `mend resume` takes `--project`. The dashboard and `mend sessions` say
`handed off from <machine>` on the worktree and its sessions.
