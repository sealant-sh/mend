---
"@sealant/mend": patch
---

Codex sessions Mend starts run with Codex's background server off
(`-c features.daemon_auto_start=false`). Codex 0.160 starts a shared server by default, and that
server first copies Codex's own release, about 427 MB, into the saved harness home, where every
later session in the worktree would receive it. Mend's launches already stayed off the server as a
side effect of another setting; the flag makes it explicit on every launch: conversation, terminal,
prompt, resume, handoff, join and claimed standby.
