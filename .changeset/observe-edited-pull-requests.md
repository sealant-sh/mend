---
"@sealant/mend": patch
---

Read back updated pull requests so landing records the current title. Keep temporary descriptions
inside a private, owned directory and remove it after publication, write failure, or interruption,
so late writes cannot recreate the description pathname after successful cleanup.
