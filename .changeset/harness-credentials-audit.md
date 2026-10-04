---
"@sealant/mend": patch
---

No session saves a login or token another person's session could pick up. An audit of Claude Code,
Codex, opencode and pi, after a clean exit and killed in the middle of a turn, found credentials the
saved harness state still held: Codex's MCP server logins (`~/.codex/.credentials.json`) and its
shell snapshots (`~/.codex/shell_snapshots/`, every exported variable with its value), pi's own MCP
logins (`~/.pi/agent/mcp-auth.json`) and its `mcp.json`, Claude Code's copies of `~/.claude.json`
(`~/.claude/backups/`) and of every file it edits (`~/.claude/file-history/`), and clones and logs
that keep a URL's token. Mend's list of them is one table, which the platform's must match and the
docs page "How Mend handles your provider logins" lists in full. Leaving them out of what a remote
workspace saves needs a Sealant runtime with sealantd#136.

Codex sessions Mend starts run with its shell snapshot off (`-c features.shell_snapshot=false`), so
the snapshot is never written. A pi session runs on its owner's freshly delivered pi profile, on
none, or does not start: Mend moves aside the profile and settings an earlier session delivered into
the worktree, never deleting them, then delivers the owner's. A pi profile restored without its
`mcp.json` is no longer delivered again and reinstalled at every resume.
