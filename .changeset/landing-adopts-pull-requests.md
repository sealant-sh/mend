---
"@sealant/mend": minor
---

Landing finds a pull request opened outside Mend and updates it instead of opening a second one.
Mend looks with the owner's `gh` 45 s after the agent pushes a branch through the workspace
transport, and again when the agent's turn ends while its workspace is up. "Check GitHub" in the
Land panel, and `mend land <session> --check`, look on demand, even when nothing has landed yet. The
lookup covers the worktree's branch, every branch the agent pushed, and any pull request that holds
the agent's head commit. The next landing pushes that pull request's branch and updates it. A pull
request from a fork is shown
(`pull request #367 · merged · observed · opened outside Mend · from anna's fork`) and never
updated, because Mend pushes to origin only. The lookup that finds the pull request to update no
longer mistakes a fork's same-named branch for origin's.
