---
"@sealant/mend": patch
---

A `claude`, `codex` or `pi` you run by hand in a session's shell or VS Code terminal is observed
with the capture store, the default store. Its executor mounts nothing from the Mend host, and Mend
was looking for the agent's transcript in a directory on the host that nothing wrote, so it never
saw one. Mend now reads the worktree's latest capture, which the workspace takes a few seconds after
a write, and finds the agent within about half a minute. In a per-person workspace it reads the
session owner's saved directory: the agent is recorded as theirs, in their own sessions only, never
in another person's session in the same workspace. A conversation from before the session started,
or one written by an agent Mend runs in the same home, is not taken for one run by hand. A hand-run
`opencode` is not observed: it keeps its conversations in a database. The VS Code page now says what
observation covers and what it does not.
