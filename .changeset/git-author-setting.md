---
"@sealant/mend": minor
---

Workspaces commit as you. "Git author" is a new account setting: a name and email in Settings, or
`mend git-author "Name" you@example.com` (`--clear` goes back to the name and email you registered
with, which is also what applies until you set one). Before the agent starts, every workspace
receives it as system git config, co-located or captured, cold or a claimed standby. A `.gitconfig`
from your dotfiles and a repository's own config still decide over it. Agents no longer have to make
up an identity to commit.
