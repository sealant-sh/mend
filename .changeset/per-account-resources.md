---
"@sealant/mend": minor
---

Give each account its own ssh-agent bridge, so a shared signer only ever signs for the account that
shared it, and send session notifications only to the session owner's phones. Reference repositories
belong to the organization: owners add, refresh and remove them with their own git access, and a
project can select only its organization's references. Calls to the GitHub API use the host's `gh`
login only for the operator of a single-organization install. Adding host mounts is refused in multi
mode, and multi mode also refuses raw service listeners off loopback.
