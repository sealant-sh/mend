---
"@sealant/mend": patch
---

Concurrent requests for the same job name and idempotency key now enqueue one live job across Mend
server instances. Queued, active and retrying jobs hold the key; terminal jobs release it. Existing
queues and pending jobs remain in place. Upgrade all producers before relying on this guarantee
during a rolling deployment.

Keyed enqueues use a separate PostgreSQL pool, with a maximum of one connection per Mend server
instance by default. Set `MEND_JOBS_ENQUEUE_POOL_MAX` to a positive integer to change that limit;
the existing worker pool remains separate.
