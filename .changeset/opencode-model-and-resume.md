---
"@sealant/mend": patch
---

opencode sessions work on the ChatGPT login without naming a model. opencode used to open on GitHub
Copilot, which it found through the git token Mend gives every workspace, and Copilot refused the
first prompt ("The requested model is not available for integrator opencode"). Each launch now names
`openai/gpt-6.1-sol` as opencode's last used model when it has an `openai` login and no recent model
of its own, so `--model`, your opencode config and a model picked inside opencode still come first.

A stopped opencode session now keeps its conversation. Mend commits opencode's database as the
session's saved state, so the session is no longer hidden as "ended without a transcript", and
resuming it opens opencode with `--continue` on the conversation it left. opencode's state directory
(`~/.local/state/opencode`: the model it last used and its prompt history) moves into the harness
home beside its data, so it survives a resume as well; a secret file may not be kept under it.
