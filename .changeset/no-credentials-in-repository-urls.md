---
"@sealant/mend": patch
---

A repository URL with a login or token in it (`https://oauth2:TOKEN@gitlab.com/org/repo.git`) is
refused at adoption and for reference repositories, as it already was for dotfiles, on every client
and the API, with a message that points to `mend keys` and the agent bridge. Before, the adopted URL
was stored as typed and every project read returned it to everyone who could see the project: on a
shared project, the whole organization. Migration 0124 removes the credential from stored URLs. A
project whose Git store still holds one (or includes another config file) is refused for fetch,
push, landing, new worktrees and session launches until an operator removes it, and the server log
names the command for each such project, at every refusal and at start; the store is never
rewritten. Repository URLs in responses, Git errors, log lines and `--json` output no longer carry a
credential.
