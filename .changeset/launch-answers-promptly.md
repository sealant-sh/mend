---
"@sealant/mend": patch
---

`POST /sessions/:id/launch` answers within 30 seconds. A launch that takes longer keeps going in the
background: the session reads `starting` and its line says where it is
(`waiting · the previous session in this worktree is saving`,
`building the workspace image (first launch after an update, ~8 min)`, `booting`). It then moves to
`running` or settles `failed` with the reason. The VS Code extension follows the session line until
the agent runs.
