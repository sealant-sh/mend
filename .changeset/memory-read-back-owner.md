---
"@sealant/mend": patch
---

Agent memory is credited only to the person it belongs to. On a server, a worktree's sessions share
one harness home, and one person's memory could be saved as another's: a session that joined someone
else's running executor read their memory back as its own, a session started in a worktree another
person had used took the memory they left there, and Codex summarised other people's conversations
in the worktree into the launcher's memory. The server now records whose memory each worktree's home
holds, and only that person's sessions read it back. A launch in a worktree another person used
first saves that person's memory for them, then moves it out of the way. Codex starts with every
conversation that is not the launcher's out of its memory, or with its memory off when Mend cannot
do that. Migration 0110.
