---
"@sealant/mend": minor
---

Mend keeps a person's own MCP servers. `GET /api/me/mcp-servers` lists them, and
`PUT /api/me/mcp-servers/<name>` adds or replaces one. A server is either a stdio command with
environment variables or an HTTP or SSE URL with headers. `DELETE /api/me/mcp-servers/<name>`
removes one. Every variable and header value is sealed with the machine's secrets key, and so is a
URL. Responses show a URL with the parts that may hold a key as `…`, such as
`https://mcp.tavily.com/mcp/?tavilyApiKey=…`, and saving that URL again keeps the sealed one.
Responses name a server's variables and headers but never return their values, and an edit keeps or
replaces each value by name. The names `mend` and `executor`, and names that start with `mend-`, are
Mend's own. Each person can keep up to 16 servers. An access key cannot list or change them.
Settings, the CLI and delivery to sessions come in later releases.
