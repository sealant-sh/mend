---
"@sealant/mend": patch
---

Adding files to a dotfiles snapshot (a merge, as the web's add-a-file does) now counts the files the
snapshot already holds against the 4MB cap. Before, only the files being added were counted, so
repeated additions could grow a snapshot past what one launch can carry. A merge that would pass the
cap is refused with "snapshot exceeds the 4MB cap with the files it already holds", and the snapshot
stays as it was.
