---
"@sealant/mend": patch
---

A message sent into a running turn stops reading "Sent into this turn" as soon as the agent takes
it: Mend records when Claude Code or Codex read the words, and the conversation then shows the
message as any sent message, placed where the agent read it.
