---
"@sealant/mend": patch
---

Keep desktop device sign-in expiry relative to response receipt, so server clock skew does not
prematurely expire a valid request or extend its lifetime. Retain that deadline through delayed
response bodies and delayed waiting, with legacy server Date handling matching the CLI.
