---
"@sealant/mend": minor
---

What Claude Code learns about a repository now outlives the session. Mend keeps each person's agent
memory per project: every session you start on it receives your memory, and what the agent learned
is saved back when it ends, keeping both sides' lines when two of your sessions changed the same
file. A second session of yours in a running workspace does not deliver memory that is already in
place. `mend memory import`, run in a checkout, brings the memory Claude Code keeps for it on your
machine. A file both sides have is merged keeping both sides' lines, and a note's frontmatter is
merged key by key, with your machine's differing value kept as a comment. Mend remembers what it
imported from each checkout on each machine, so the next import from there merges only what changed
since and does not bring back a file removed in Mend. `--dry-run` shows the plan for each file, and
every version an import replaces is kept. The import reads no transcripts, logins or settings.
`mend memory`, `mend memory show` and `mend memory rm` list, print and remove your memory.

Your memory never reaches anyone else's sessions, and is credited only to you. In a workspace that
shares one home, the server records whose memory the home holds and only that person's sessions read
it back. A launch in a worktree another person used first saves their memory for them and moves it
aside, never deleted. A Codex session there that joins someone else's executor starts with memory
off. Migration 0111.
