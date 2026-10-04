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
home beside its data, so it survives a resume as well. A secret file may no longer be kept under it,
and one delivered there before is removed from the workspace before that directory is saved.

The co-located store's saved harness state no longer includes opencode's login files (`auth.json`,
`mcp-auth.json`).
