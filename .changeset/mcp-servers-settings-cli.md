---
"@sealant/mend": minor
---

Settings has an MCP servers tab under You. It lists your own MCP servers with each one's transport,
its command or URL host and the names of its saved variables or headers, never their values. You can
add, edit, turn on or off, and remove a server there. An edit keeps, replaces or removes each saved
value by name and never shows one. Your organization's Executor is a row in the same list: open it
to link your account and, as an owner, to set up the organization's Executor. The Executor tab under
Organization is gone, and its old address opens this row. The CLI gains `mend mcp`, `mend mcp add`,
`mend mcp remove` and `mend mcp on|off`. `mend mcp add` never reads a value from the command line: a
terminal asks for each one without showing it, and without a terminal stdin carries `NAME=value`
lines.
