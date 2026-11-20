---
"@sealant/mend": patch
---

A session started without a prompt is now named from the first message it is sent, from the web, the
CLI or VS Code. Before, Mend looked for that message only in the agent's own transcript, which it
often couldn't read, and the session stayed unnamed. Until a session is named, it reads as the first
line of its first message, or "New session" before it has been sent anything. It no longer reads as
its worktree's name, which made a second session in a worktree look exactly like the first.

Naming no longer fails for an account whose naming runs on Codex: Codex refused the namer's answer
format, so those sessions were never named.
