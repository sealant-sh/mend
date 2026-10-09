---
"@sealant/mend": patch
---

A person's first shell in an executor opens without waiting for a login. A shell names more
providers than the agent that started the executor (Codex beside Claude, say), so the first shell
waited for Mend to write the missing ones (0.3 to 0.4 s). Once the person's home exists, the shell
now starts at once, and those logins are written while it opens.
