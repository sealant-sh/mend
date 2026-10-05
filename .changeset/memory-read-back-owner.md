---
"@sealant/mend": patch
---

Agent memory is credited only to the person it belongs to. On a server, a worktree's sessions share
one harness home, and one person's memory could be saved as another's: a session that joined someone
else's running executor read their memory back as its own, a session started in a worktree another
person had used took the memory they left there, and Codex built memory from other people's
conversations in the worktree. The server now records whose memory each worktree's home holds, and
only that person's sessions read it back. A launch in a worktree another person used first saves
that person's memory for them, then moves it aside, never deleted. A Codex session in your own home
builds memory only from your conversations, or starts with memory off when Mend cannot arrange that.
A Codex session that joins someone else's executor starts with memory off, and the conversations it
starts never build anyone's memory. Migration 0111.
