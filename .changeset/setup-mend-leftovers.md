---
"@sealant/mend": patch
---

A fresh `mend server setup` in a Docker engine that holds what an earlier Mend install left now says
what it found. Before, a single network left behind (`mend_default`, with Mend's Compose project
label and nothing attached) stopped the install with "Docker volume ownership check failed
(unowned-data, existing network without anchor) … do not delete or relabel existing data". Now setup
names each thing: the bundle's networks with nothing attached, stopped containers a generation
started, and volumes with Mend's installation label or the bundle's Compose names. On a terminal it
offers to remove them before the first question. No is the default, and when volumes are among them
it says their data goes with them. With flags or no terminal it points at
`DOCKER_CONTEXT=<context> mend uninstall --server`.

`mend uninstall --server` removes these leftovers when no installation is configured, a network or a
stopped container alone included. After a setup that stopped before it activated a generation, it
also removes the volumes that setup claimed (the anchor last) along with its identity, so the next
setup is not refused.

A network, container or volume that only shares a name with Mend's is still refused, in plain words:
setup names it and says which label it carries (another Compose project's, or none). It gives the
`docker … inspect` command that shows what it is, and suggests another Docker context. Docker
failures and an identity that does not match keep their refusals.
