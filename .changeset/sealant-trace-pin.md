---
"@sealant/mend": patch
---

The bundled sealant is 0.40.0-next.945. When a server reports to Sentry, Mend's calls into sealant
now carry their trace, so a session's start reads as one trace from Mend's API through sealant's,
and sealant's own processes report to the sealant project the operator names with
`mend server setup --sealant-sentry-dsn`. A saved Boat image Boat no longer has is now quarantined
as missing, and sealant says so in its log.
