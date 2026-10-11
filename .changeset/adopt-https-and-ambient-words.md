---
"@sealant/mend": patch
---

A private repository adopted by its `https://` URL no longer reads as a refused key. On a server
from `mend server setup`, Mend's own Git holds no HTTPS credential, so the clone always failed, and
the message told you to add your Mend key (or check the shared agent), neither of which can sign an
HTTPS clone. Adoption, refresh, reference repositories and landing now say the remote is HTTPS and
name the SSH URL to adopt instead (for GitHub, GitLab, Bitbucket and Codeberg on their default
port). A failed clone or fetch says only a public repository reaches Mend that way. A failed push
says a public repository clones over HTTPS without a credential, but a push needs one. A server run
from source as your own user still uses that user's git credential helper for HTTPS, as before. An
https URL that git sends over ssh (a `url.<base>.insteadOf` rewrite) keeps the ssh reading. GitHub's
ssh `ERROR: Repository not found.` now reads as the key not being authorized for the repository. An
ambient refusal no longer says to try `git ls-remote` "in a shell here": on a server from
`mend server setup` the server's container holds no key, agent or git credential of its host, and
the line names `--auth mend-key` and `mend keys share`. In the dashboard, a refused adoption keeps
the offer open with the server's reason in it, so you can pick another mode and try again; before,
the reason showed for five seconds on one truncated line.
