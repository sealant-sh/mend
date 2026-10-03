---
"@sealant/mend": minor
---

A pull request the agent opens with `gh pr create` is recorded when the turn that opened it ends,
not when the agent stops. The look reads the pull request the turn named, in a command's output or
the agent's own message, and keeps it only when GitHub says it was opened during that turn; it runs
before automatic landing decides the turn, so a landing updates that pull request instead of opening
a second. Mend now keeps each pull request's title, and the project and worktree lists carry each
change's newest pull request (`#412 · open`, its title and URL) from one indexed read, never from
GitHub. Migration 0104 adds the title column and that index.
