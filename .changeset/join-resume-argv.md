---
"@sealant/mend": patch
---

A session resumed on a server while another session in its worktree holds the executor continues its
own conversation. The resume joined that executor and started Claude, Codex, opencode or pi with no
resume arguments, so the harness opened a new conversation while the session's process named the old
one. The join now passes the same resume arguments as a resume in a fresh executor.
