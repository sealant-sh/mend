---
"@sealant/mend": patch
---

Mend asks git which URL it will dial before choosing who signs: `git ls-remote --get-url` for a
fetch, and `git remote get-url --push` for a landing's push, so `url.<base>.insteadOf` and
`pushInsteadOf` apply exactly as git applies them. Mend used to re-implement git's rewrite rule and
got ties wrong: with two bases matching the same prefix, git keeps the base it saw first in its
config, and Mend could read an ssh rewrite as https. The ssh operation then failed with no signer
instead of signing with your Mend key or bridge. When git cannot answer, Mend still asks for a
signer.

When Mend signs (your Mend key, your bridge, or a session's git through the workspace transport),
its ssh now ignores the server user's `~/.ssh/config`: an `IdentityFile` there is no longer offered
beside the Mend key, and an `IdentityAgent` no longer replaces the bridge's socket. A server run
from source that reached a git host through a `Host` alias or a `ProxyJump` in that file must use
the host's real name.
