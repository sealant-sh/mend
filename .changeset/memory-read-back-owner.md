---
"@sealant/mend": patch
---

Agent memory is credited only to the person it belongs to. On a server, a worktree's sessions share
one harness home, and one person's memory could be saved as another's: a session that joined someone
else's running executor read their memory back as its own, and a session started in a worktree
another person had used took the memory they left there. The server now decides whose memory an
executor holds, the person whose launch made it, and only their sessions read it back. A launch in a
worktree another person used first saves that person's memory for them, then moves it aside, never
deleted, before laying down the new person's. What a joined agent learns goes into the executor
owner's memory, not the joiner's.
