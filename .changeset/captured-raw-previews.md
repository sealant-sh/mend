---
"@sealant/mend": patch
---

Preview images, documents and media from captured worktrees and checkpoints. Mend prepares files up
to 2 GiB in an 8 GiB disk cache, then serves later opens and seeks without Git or capture
restoration. Preparation that takes longer than ten seconds continues in the background; reopen the
preview once it finishes. Captured asset URLs keep their original observation when a newer capture
arrives. Every request still checks project access.
