---
"@sealant/mend": patch
---

A sealing register reads each pack at most once. On a bucket that does not refuse overwrites
(Garage), one register of a large repository had read every pack again for each hardlinked file it
checked: about 40 GB of reads for 0.78 GB of packs, taking 4.5 minutes. A register now answers
within 40 seconds. If the seal checks take longer, the capture registers, the answer says the seal
is withheld while verifying, and the seal is recorded once the checks pass. A retried register joins
the one already running instead of starting a second.

Upload URLs now last as long as their uploads need: at least 5.5 minutes, at most 15. On Garage a
Stop's seal is withheld for about 10.5 minutes instead of 20.

A capture step that runs past its bound (sealantd's `overdue`) shows on the session as
`capture step overdue · <step> · running … · bound …`, and such a session never reads idle or saved.
Migration 0093 adds the columns. Core does not forward the field yet.

Sessions on SHA-256 projects start: capture 0 names the object format. A launch interrupted by a
lost create answer now settles `stopped` once its executor ended, instead of staying `starting`. A
withheld seal reads `final seal not confirmed`, not `not registered`. A session-channel request
whose token lookup fails gets a 503 instead of stopping the Mend process.
