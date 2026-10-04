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
the snapshot is never written. A pi session Mend starts runs on its owner's freshly delivered pi
profile, on none, or does not start, whether it launches fresh or joins, resumes or follows up in a
workspace that is already running: Mend moves aside the profile and settings an earlier session
delivered into the worktree, never deleting them, then delivers the owner's. Beside another person's
running pi, a pi session does not start; beside the same person's, it runs on the profile already
there. A pi typed by hand in a session that is not a pi session is not set up (known issues). A pi
profile restored without its `mcp.json` is no longer delivered again and reinstalled at every
resume.
