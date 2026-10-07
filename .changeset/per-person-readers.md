---
"@sealant/mend": patch
---

Behind `MEND_HARNESS_LAYOUT=person`, which is off by default, Mend now reads each person's
conversations and agent memory back from their own saved directory in the worktree: when two people
work in one worktree, each session resumes its own conversation and each person's memory is saved
for them alone, never the other's. A session from before the worktree ran per person resumes from
its conversation as the last workspace that shared one home saved it; the conversation is copied
into its owner's directory only if they do not already have it, and nothing is moved or deleted.
With the flag off, sessions run exactly as before.
