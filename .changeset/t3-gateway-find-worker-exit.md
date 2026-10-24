---
"@sealant/mend": patch
---

When the T3 Code gateway's find worker exits while it waits for the next search, the gateway now
starts a new one and frees the old worker's slot. Before, the next find in a thread could wait
forever on the exited worker and keep one of the four worker slots that find and highlighting share.
A worker that exits as it starts, or just after it answers, no longer stalls a search either.
