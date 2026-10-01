---
"@sealant/mend": minor
---

What Claude Code learns about a repository now outlives the session. Mend keeps each person's agent
memory per project: every session you start on it receives your memory, and what the agent learned
is saved back when it ends, keeping both sides' lines when two of your sessions changed the same
file. `mend memory import` brings the memory Claude Code already keeps for the checkout on your
machine; `mend memory`, `mend memory show` and `mend memory rm` show and remove it. Your memory
never reaches anyone else's sessions. Transcripts, logins and settings are never read.
