---
"@sealant/mend": minor
---

Sessions start with your own MCP servers. Every Claude, Codex or pi session you start gets the
servers you keep in Mend that are on, next to Mend's own server and the repository's `.mcp.json`.
Claude gets every server; Codex gets stdio and HTTP servers; pi gets them through your pi profile's
`mcp.json`; opencode gets none yet. Variable and header values reach the agent in files only its
user can read, never on a command line, a process row or in its environment. When you steer someone
else's session, your turn runs with your own servers, never theirs. The session line says which
servers a session got, or why it got none. See "Use your own MCP servers" in the docs.
