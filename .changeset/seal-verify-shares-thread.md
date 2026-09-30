---
"@sealant/mend": patch
---

A seal's checks no longer stall the Mend server. On alpha, a seal over a 1.57 GB capture (a pnpm
`node_modules`) held the API's thread for over ten minutes, and every other request waited 6–10
minutes. Mend now decodes each dir object once per check instead of once per member looked up
through it, hashes and decompresses in slices that let other requests run between them, and runs one
seal verification at a time. On a bucket that refuses overwrites (S3, R2, MinIO), a later seal also
reuses the member digests and object proofs an earlier one took instead of reading those bytes
again. On a bucket that does not (Garage), every seal reads everything again, as before.
