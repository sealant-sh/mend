---
"@sealant/mend": minor
---

A session can go back to a checkpoint.

- **Go back from the conversation or the review.** A checkpoint line's details offer
  `Go back to this checkpoint…`, and the Change tab's range picker offers
  `Go back to a checkpoint…`. One dialog says what changes before anything does. Only the change's
  owner sees it.
- **Nothing is lost.** Mend saves the files as they are as a new checkpoint first, then puts the
  worktree's files back to how they were at the one picked, and takes one more checkpoint after.
  Tracked files and untracked files that aren't ignored go back; ignored files, the branch and its
  commits stay as they are.
- **Undo from the line it leaves.** Every session in the worktree shows `Went back to checkpoint N`,
  whose details offer going back to the saved checkpoint.
- **Refused while an agent works.** If any session in the worktree has a turn running or queued, or
  a terminal agent at work, the dialog says so and nothing changes.
- **The agent is told.** Each session's agent reads a note ahead of the next message a person sends
  it, saying which checkpoint the files went back to. The message shows as the person wrote it.
