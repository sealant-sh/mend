---
"@sealant/mend": minor
---

A Claude session also gets your own Codex login, and a Codex session your own Claude login, when you
have connected it, so the agent can run `codex` or `claude` on your login: a Codex review from a
Claude session, or pstack's Codex seat. Only your own logins are given. In a per-person workspace
your other agent's login goes into your own home, and under shared control there a sender's turn
reads the sender's own login, never the session owner's. A login of the other agent that is missing
or needs reconnecting is left out, and the session starts without it. To give each session its own
agent's login only, turn on **Give my sessions only the selected agent's login** in Settings →
Connected accounts, or run `mend agent-logins selected` (`mend agent-logins all` turns it back).
Migration 0131.
