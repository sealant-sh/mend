---
"@sealant/mend": patch
---

Read every repository timestamp, expiry and sweep cutoff from the Effect clock instead of the host
clock, in Postgres and in-memory repositories alike. Columns Postgres stamps itself, and every TTL,
grace and stale window, are unchanged.
