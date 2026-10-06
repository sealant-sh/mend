---
"@sealant/mend": patch
---

A Codex session whose saved thread is gone now says "Codex could not find this conversation's
thread. Nothing was sent." when it is resumed. Mend now matches Codex's own error,
`no rollout found for thread id …`, so the line actually appears. A resume that fails for any other
reason, such as an unknown model, shows Codex's own message instead of being reported as a missing
thread.
