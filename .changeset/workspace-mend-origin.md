---
"@sealant/mend": minor
---

An agent in a session knows where Mend's web app is. Every process in a workspace gets
`MEND_ORIGIN`, set to the server's `APP_URL`, with or without a session channel, and the workspace
note in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` tells the agent to link people there when
they need to do something in Mend itself, such as adopting a project. A resource can still be named
`app`, `origin` or `web`.
