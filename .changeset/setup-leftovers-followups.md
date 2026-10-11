---
"@sealant/mend": patch
---

A guided `mend server setup` on a fresh machine now says before its first question when something
that is not Mend's stands where the install goes, or when Docker cannot list what is there. Before,
it asked every question and then refused. When several things are in the way, setup names each one,
says why it cannot install beside it, gives the `docker … inspect` command for each, and names any
leftovers of an earlier install beside them. A volume that only shares a name with Mend's is refused
in the same words as a network or container. When Docker refuses to remove a leftover after a yes,
setup says to stop what uses it and run setup again.
