---
"@sealant/mend": patch
---

opencode sessions work on the ChatGPT login without naming a model. opencode used to open on GitHub
Copilot, which it found through the git token Mend gives every workspace, and Copilot refused the
first prompt ("The requested model is not available for integrator opencode"). Each launch now names
`openai/gpt-6.1-sol` as opencode's last used model when it has an `openai` login and no recent model
of its own, so `--model`, your opencode config and a model picked inside opencode still come first.

A stopped opencode session now keeps its conversation. When the session stops, Mend reads which
conversation in opencode's database the session started and records it, so the session is no longer
hidden as "ended without a transcript", and resuming it opens that conversation
(`opencode --session <id>`), never another session's in the same worktree. When Mend cannot tell
which conversation is the session's, the resume is refused and says so. opencode's state directory
(`~/.local/state/opencode`: the model it last used and its prompt history) moves into the harness
home beside its data, so it survives a resume as well. A secret file may no longer be kept under it.
One delivered there before is taken out of the workspace's copy before that directory is saved:
removed while it holds what Mend wrote, otherwise moved whole to `~/.mend/secret-files-set-aside/`
(the session line says where). When that cannot be done, the launch stops instead of saving it.

The co-located store's saved harness state no longer includes opencode's login files (`auth.json`,
`mcp-auth.json`).

In a remote workspace, opencode's MCP server logins (`mcp-auth.json`) are kept out of what the
session saves when Mend starts opencode: the file in its data directory is a link into the
workspace's own home. A copy an earlier saved session brought is removed unread before any session
in the worktree starts, whatever its harness. A shell resume of an opencode session whose
conversation Mend cannot attribute opens the shell instead of refusing.
