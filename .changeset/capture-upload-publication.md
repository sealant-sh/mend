---
"@sealant/mend": patch
---

Recheck the capture upload lease after bucket reads and URL signing, and charge upload bytes only
after the publication check commits. Serialize final byte accounting with capture registration so
overlapping requests cannot spend the same remaining allowance. Abort request-owned multipart
uploads when signing fails or is interrupted. The check observes the holder's lease before handing
off the response; it cannot revoke URLs already delivered or keep a lease alive after the check.
