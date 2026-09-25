---
"@sealant/mend": patch
---

Mend caps its database connections: 6 for its queries (`MEND_DATABASE_POOL_MAX`), 3 for the job
queue (`MEND_JOBS_POOL_MAX`) and 3 for sign-in sessions (`MEND_AUTH_DATABASE_POOL_MAX`), where each
pool was previously uncapped at pg's default of 10. A refused connection from the job queue or the
sign-in pool is logged and retried instead of exiting the API. The bundled image waits up to 240 s
for Mend's first health answer before it restarts the bundle.
