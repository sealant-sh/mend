---
"@sealant/mend": patch
---

Raise the packaged T3 Code gateway's data limit to 2 GiB so find in a thread and Files search
highlighting can start their workers without crashing the gateway. Workers use 64 MiB code ranges
and share four slots across find and highlighting, with slots held until termination completes. The
heap stays at 256 MiB.
