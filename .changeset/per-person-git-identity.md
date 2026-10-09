---
"@sealant/mend": patch
---

With `MEND_HARNESS_LAYOUT=person`, the default, per-person harness homes (ADR 0016) now give each
process its own git and Mend identity. Every person in a workspace gets their own session token, so
`git push` and the `mend` helper act as the person whose process runs them, with their own Mend key
or signer. The token and the person's git author reach their home through a single-use pickup that
only that person can redeem; neither is ever part of a command's arguments. Shells and Services run
as the person who started them. The workspace's own token is refused for git and the helper there.
With `MEND_HARNESS_LAYOUT=shared`, sessions run exactly as before.
