---
"@sealant/mend": patch
---

A Stop whose session committed a large file no longer verifies the git pack twice. The register
copies it down and verifies it once; the seal compares the stored index with the one verified and
reads the pack again only if that changed. A 627 MB pack cost 7.9 s less on the box.
