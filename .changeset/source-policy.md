---
"@sealant/mend": minor
---

Mend checks where its own git goes. Adoption, reference repositories, dotfiles and project refreshes
are refused for the cloud metadata service and, except for the operator, this machine;
`MEND_SOURCE_POLICY=tenant` also refuses private and reserved networks and `git://` unless
`MEND_SOURCE_ALLOWED_HOSTS` allows them. A workspace's git transport now signs only against its
project's own remote; `MEND_GIT_TRANSPORT_BIND_ORIGIN=false` restores the old behavior for a machine
one person uses.
