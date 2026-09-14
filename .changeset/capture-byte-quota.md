---
"@sealant/mend": patch
---

The capture store's byte quota is checked before bytes land, and is sized for captured dependency
trees. `upload.urls` refuses a batch whose declared sizes would take the session past its quota with
413 `{reason: "byte-quota", limit, used, requested}` before any URL is minted; a key is priced once
(reserved at its declared size, settled at the size the bucket reports when a register names it), so
re-listed packs and retried batches cost nothing again. `capture.register` keeps the check as the
backstop for keys uploaded without a size and answers 409 with the same body — a refusal of that
capture, not a transport failure to retry. The floor rises from 512 MiB to 8 GiB per session
(`MEND_CAPTURE_BYTE_QUOTA_FLOOR`; chart `captureStore.byteQuotaFloorBytes`), above which the 4×
footprint rule still applies: on the cluster the first bulk capture of a Mend-size `node_modules`
(775 MB, 134,103 files) was uploaded in full and then refused at register, and the executor retried
it every 5 s.
