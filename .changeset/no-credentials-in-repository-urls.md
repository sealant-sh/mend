---
"@sealant/mend": patch
---

A repository URL with a login or token in it (`https://oauth2:TOKEN@gitlab.com/org/repo.git`) is
refused at adoption and for reference repositories, as it already was for dotfiles, on every client
and the API, with a message that points to `mend keys` and the agent bridge. Before, the adopted URL
was stored as typed and every project read returned it to everyone who could see the project: on a
shared project, the whole organization. Migration 0121 removes the credential from stored URLs, and
each worker start removes it from the Git remotes in the store and logs the projects it changed. A
project that fetched only through that token no longer does: adopt it again from its SSH URL.
Repository URLs in responses, Git errors and log lines no longer carry a credential.
