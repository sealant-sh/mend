---
"@sealant/mend": patch
---

Behind `MEND_HARNESS_LAYOUT=person`, which is off by default, everything Mend puts into a workspace
for a person now goes into that person's own home, as them: their skills, agent memory, secret
files, pi profile, carried Codex conversations and Mend's default shell profile. Two people in one
worktree each get their own; a second person's pi runs on their own profile beside the first
person's. A login someone makes inside opencode is removed from their opencode data before their
opencode starts and after it ends. Your agents can wait for your dotfiles' `install.sh` where
someone else started the workspace: turn on "Start my agents after install.sh"
(`PUT /api/dotfiles/start-after-install`); otherwise the agent starts beside it and the session line
says "install.sh running" until it ends. With the flag off, sessions run exactly as before.
