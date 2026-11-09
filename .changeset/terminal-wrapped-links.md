---
"@sealant/mend": patch
---

A link that wraps over several rows of a web terminal opens whole. Before, Ctrl-click (⌘-click on a
Mac) on a long sign-in URL, such as the one `claude mcp login` prints for an MCP server, opened only
the part on its first row, which the server refused. Hovering any row of a wrapped link now
underlines the whole link, and the click opens all of it.
