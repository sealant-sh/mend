---
"@sealant/mend": patch
---

The dashboard no longer bounces on Enter while a session's workspace is still booting. A `starting`
row has no terminal to attach yet, so Enter now leaves the dashboard up and says so, instead of
suspending the screen once per keystroke and returning. A worktree header attaches its newest live
member that is past starting.
