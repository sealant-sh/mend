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
