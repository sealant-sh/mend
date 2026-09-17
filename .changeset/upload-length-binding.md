---
"@sealant/mend": minor
---

Capture uploads can no longer store more than they declared. Presigned PUT and part URLs sign the
declared size, so an S3-compatible bucket refuses any other length; a multipart upload must complete
with exactly the parts its size implies, and an object whose stored size differs from its
declaration is removed and refused with `size-mismatch` at complete or register.
`MEND_CAPTURE_REQUIRE_SIZES=true` also refuses keys sent without a size (today's sealantd sends
sizes only for multipart keys).
