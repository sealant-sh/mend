---
"@sealant/mend": patch
---

With `MEND_HARNESS_LAYOUT=person`, the default, per-person harness homes (ADR 0016) now give each
person their own logins. When someone starts a session in a worktree where another person's session
runs, their agent runs on their own Claude, Codex and GitHub logins, written into their own home,
and never on the other person's. If they have not connected the provider the session needs, the
start is refused with "Connect Claude to start a session here." Their logins are removed when their
last process there ends, and written again if the agent is refused for its login. pi and opencode
get their ChatGPT login without it ever entering saved state. With `MEND_HARNESS_LAYOUT=shared`,
sessions run exactly as before.
