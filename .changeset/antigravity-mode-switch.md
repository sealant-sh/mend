---
"@sealant/mend": patch
---

An Antigravity session now switches between a terminal and a conversation and keeps its
conversation, as Claude Code and Codex sessions do: "Continue as a conversation" on the web, the
phone's pickup, and `mend attach`, `mend resume` or the dashboard's `a` on an Antigravity
conversation. In a terminal Antigravity session the web composer still says to type in the terminal,
since agy has no hooks for Mend to type at its turn boundaries.
