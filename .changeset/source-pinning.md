---
"@sealant/mend": minor
---

Under `MEND_SOURCE_POLICY=tenant`, git dials exactly the address the source policy checked, over
HTTPS and ssh, so a name cannot resolve somewhere else between the check and the connection. The
dotfiles clone at each launch is now checked and pinned too.
