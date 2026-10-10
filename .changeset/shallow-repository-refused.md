---
"@sealant/mend": patch
---

A shallow repository (a `git clone --depth` copy, a CI checkout, a mirror made from one) is now
refused at adoption, and a project adopted from one before is refused when a session starts on it:
"Mend doesn't support shallow repositories yet. Make the repository complete where it is hosted
(`git fetch --unshallow`), then adopt it again." A session on one could never save: every save's git
section failed verification at the shallow boundary, and its Stop read `saving` for up to 10
minutes, then `final seal not confirmed`. A Stop whose final seal Mend refuses because the head's
git section failed verification now reads
`not saved · final seal refused · git section failed verification · workspace kept` on the first
final flush, and keeps the workspace. A shallow checkout on your own machine still adopts through
its `origin` URL, in full.
