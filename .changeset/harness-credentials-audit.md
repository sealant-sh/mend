---
"@sealant/mend": patch
---

No session saves a login or token another person's session could pick up. An audit of Claude Code,
Codex, opencode and pi found credentials the saved harness state still held: Codex's MCP server
logins (`~/.codex/.credentials.json`, where Codex keeps them in every workspace, which has no
keyring), pi's own MCP logins (`~/.pi/agent/mcp-auth.json`) and its `mcp.json`, and Claude Code's
copies of `~/.claude.json` (`~/.claude/backups/`), device keys, shell snapshots, hook environment
and IDE tokens. Mend's list of them is one table, which the platform's must match and the docs page
"How Mend handles your provider logins" lists in full. Leaving them out of what a remote workspace
saves needs a Sealant runtime with sealantd#136.
