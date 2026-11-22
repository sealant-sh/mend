---
"@sealant/mend": patch
---

An Antigravity session now switches between a terminal and a conversation and keeps its
conversation, as Claude Code and Codex sessions do: "Continue as a conversation" on the web, the
phone's pickup, and `mend attach`, `mend resume` or the dashboard's `a` on an Antigravity
conversation. agy has no hooks, so in a terminal Antigravity session the web composer still says to
type in the terminal, and the turns typed there stay in agy's conversation without showing on the
web: the conversation says so while it is a terminal.
