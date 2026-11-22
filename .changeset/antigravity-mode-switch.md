---
"@sealant/mend": patch
---

An Antigravity session now switches between a terminal and a conversation and keeps its
conversation, as Claude Code and Codex sessions do: "Continue as a conversation" on the web, the
phone's pickup, and `mend attach`, `mend resume` or the dashboard's `a` on an Antigravity
conversation. agy has no hooks, so in a terminal Antigravity session the web composer still says to
type in the terminal. The turns typed there stay in Antigravity's own conversation but don't show on
the web, and the session's conversation says so once Antigravity has run in a terminal. In a
terminal, agy no longer asks whether to trust the repository, and a conversation reopened there no
longer reads "Invalid Project".
