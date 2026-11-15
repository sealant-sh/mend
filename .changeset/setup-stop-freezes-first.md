---
"@sealant/mend": patch
---

Stopping setup no longer lets a step run its next command. Stop now pauses every process the step
started before it ends any of them, so a step's shell can no longer see a command it waits on end
and go on to the next line, such as a `rm`, a `git` write or a migration, in the worktree or
workspace.
