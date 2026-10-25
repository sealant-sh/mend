---
"@sealant/mend": patch
---

Preview images, documents and media from captured worktrees and checkpoints. Captured previews show
the files' bytes as the agent wrote them, before line-ending and LFS filters. Mend prepares files up
to 2 GiB in an 8 GiB disk cache, then serves later opens and seeks without Git or capture
restoration. The limits are per API process; a default install runs one, so the cache uses at most 8
GiB. Preparation that takes longer than ten seconds continues in the background; reopen the preview
once it finishes. Captured asset URLs keep their original observation when a newer capture arrives.
Every request still checks project access.
