---
"@sealant/mend": patch
---

Each item of the server's exposure report (`GET /api/operator/exposure`) and of the multi mode gate
(`GET /api/operator/gate`) now names its case in a `reason` field and carries that case's data in
fields of its own: the plain http origins, the budgets that are off, where workspace SSH is
published, the version a security review names, and so on. The web app's Settings → Server words
each check from these. `detail` and `fix` are unchanged, so `mend operator exposure` and
`mend operator gate` print what they printed before.
