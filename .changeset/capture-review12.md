---
"@sealant/mend": patch
---

A final seal is no longer refused because the store failed a read while Mend checked it. A 503 or a
timeout from the bucket, or a database error while recording the seal, now answers `seal: withheld`
with the reason `unavailable`. Mend drops that check, and the executor's next register checks the
capture again and records the seal. Before, the refusal was cached as `unrestorable`, or the seal
read `verifying` forever, until Mend restarted. Only bytes that are missing or read back wrong
refuse a seal.

A session resumed into a workspace kept by a Service no longer reads
`running · executor not answering · …` once that executor has answered and started the new process.
`executor lost · …` stays until a replacement picks the session up.
