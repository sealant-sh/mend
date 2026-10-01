---
"@sealant/mend": patch
---

pi and opencode run on your ChatGPT subscription through the Codex login you connected. At each
launch Mend writes that login into the tool's own `auth.json` (pi's `openai-codex`, opencode's
`openai`), as a copy that cannot refresh; a login made inside the session is never replaced, and pi
defaults to it only when you chose no provider.
