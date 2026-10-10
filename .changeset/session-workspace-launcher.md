---
"@sealant/mend": patch
---

The API's session list and view say who launched each session's executor
(`workspaceLauncherUserId`): the owner of the session whose own launch made it, which a session that
joined the worktree is not. Remote-SSH into a workspace admits only that person, so an editor can
say so before it opens instead of ending in a bare permission denial. Read in the same query as
`livePeople`; on 300 live sessions the list view's median stayed within noise (about 22 ms either
way).
