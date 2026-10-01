---
"@sealant/mend": patch
---

A tour, "Read this change" or "Suggest fixes" runs on the login of the person who asked for it, no
longer on the change owner's. Passes review prep queues run on the login of the session that
settled, and the tour a landing asks for on the lander's. A pass queued before this release says
`the pass was queued before Mend recorded who asked for it · ask for it again`. Automatic landing
reads a request's intent on the login of the turn's sender, and on no one's when the turn records
none.
