---
"@sealant/mend": minor
---

`mend land <session>` publishes a session's change: Mend takes a checkpoint, commits what the agent
left uncommitted, pushes the branch to origin (fast-forward only, never forced), and opens or
updates its GitHub pull request. `--branch` names the branch on origin, `--no-pr` pushes only, and
`--title` sets the pull request's title. It prints the landing and what Mend observed, in the
remote's own words when a push is refused, and exits 1 then. Only the session's owner lands.

`mend pull <session>`, run in a local clone of the project, fetches the change as `mend/<name>` from
a git bundle, before landing and without origin. It leaves the working tree and the current branch
alone, only fast-forwards an existing branch, and refuses a bundle over the server's limit with its
size.

`mend codex|claude|opencode` take `--land` and `--no-land`, which override the project's "Land when
a turn completes" setting for one session.
