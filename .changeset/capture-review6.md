---
"@sealant/mend": patch
---

Mend orders capture evidence by the executor's own stamp (`origin`: launch, boot, boot generation,
observation), never by wall clocks (migration 0087). A seal stands for a lost final flush answer
only when every unsaved answer the executor gave comes strictly before it; an answer nothing orders
against it keeps the workspace. Every answer moves a per-executor evidence version. An answer still
in flight, or one that failed to persist, leaves the executor's evidence unknown. A completion
attestation, and a `stopped outside Mend · saved` end, commit only on the version they read. A
stop's attestation carries the seal's stamp.

Stored capture objects are write-once. Presigned PUTs sign `If-None-Match: *`, and `upload.urls`
answers a key the bucket already holds as `present` after checking its bytes against its name.
Cached checks of a key's bytes are bound to the store, and are trusted only once no upload URL can
replace the object. The directory store publishes objects read-only. Garage v2.4.1 replaces bytes
despite the header (measured). MinIO refuses with 412.

A final seal also needs every tracked `hardlinks` group to be one blob of the tree the restore
checks out, and every `shared` link to name a file its class carries with the tracked file's bytes.
