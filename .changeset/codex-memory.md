---
"@sealant/mend": minor
---

Codex memory is carried per person per project, like Claude's. Mend turns Codex's memory on in every
Codex session it starts, keeps Codex's memory folder and summary database with your other memory,
and carries your earlier Codex conversations on the project into each new session, so Codex has
something to learn from. `mend memory import` also brings the summaries Codex made on your machine
of conversations held in the repository. `mend memory show codex:MEMORY.md` shows Codex's files.
Codex's summary databases are merged by conversation.
