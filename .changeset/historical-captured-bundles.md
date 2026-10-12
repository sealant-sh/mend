---
"@sealant/mend": patch
---

Pull captured changes from the agent history recorded at their checkpoint, restoring the retained
historical Git objects even after the runner cache is deleted. If retention removed that capture or
its required Git objects, Mend now refuses the bundle with a reason instead of including newer agent
commits. This preserves the existing retention policy and does not guarantee indefinite availability
of historical bundles.

Owner checkpoints also use the captured HEAD for detached worktrees, preserving the agent commits
when the store still holds an older branch ref.
