---
"@sealant/mend": patch
---

Mend's Git signer now pushes only to the project's own repository, or another repository the session
holds. A `git push` from a session to a different repository on the same host is refused with the
repository it may push to, and a project with no origin pushes nowhere through the signer. Fetches
still reach any repository on the origin's host, so submodules and private dependencies there keep
working. An operator who set `MEND_GIT_TRANSPORT_BIND_ORIGIN=false` is unaffected.
