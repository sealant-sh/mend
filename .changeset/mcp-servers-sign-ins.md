---
"@sealant/mend": minor
---

Sign in to an MCP server once. When you sign in to one of your HTTP or SSE MCP servers, such as
Figma, with `/mcp` in a Claude session, Mend keeps the sign-in, sealed, and puts it back in every
Claude session you start, so the server is connected without asking again. Settings → MCP servers
and `mend mcp` show `signed in · observed <time>`. **Forget**, or `mend mcp forget <name>`, deletes
Mend's copy and removes it from the Claude sessions that start after. Changing a server's URL or
transport forgets its sign-in too. Codex sign-ins are not kept yet.
