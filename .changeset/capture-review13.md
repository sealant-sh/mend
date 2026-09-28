---
"@sealant/mend": patch
---

A git step the Mend host could not finish no longer marks a sound capture `failed`. Before, one
`git index-pack` killed by the OOM killer, a full disk while a pack was staged, or a large
repository whose object walk printed past the 64 MiB buffer recorded the capture `failed` for good.
Every later plan then restored an older git section under the newest capture, which dropped the last
turns' commits and left a repository `git fsck` refused, and the final seal was refused on every
ask. Now only git rejecting a pack's bytes, or a missing object, records `failed`. Anything else
leaves the capture unverified, and it is checked again on the next register, seal re-ask or plan.
The object walk no longer buffers git's output.

A plan never mixes an older git section with a newer capture. If Mend cannot verify the head right
now, the executor waits and asks again, and the session reads
`launch waiting · capture <n>'s git section could not be verified on the Mend host · asked again`.
If git rejects the head's content, the newest capture that verifies is restored whole, and the
session reads `restored capture <m> · capture <n>'s git section failed verification`. Migration 0094
resets every capture recorded `failed` to unverified, once, so it is verified again.
