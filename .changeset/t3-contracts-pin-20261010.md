---
"@sealant/mend": patch
---

The t3code gateway now speaks t3code `v0.0.46-nightly.20261010.2922`, on Effect `4.0.2`. It checks
every call against the paired client's scopes as t3code's own server does, answers t3code's granular
permissions, serves the methods that nightly added (observing a terminal without starting one, and
reading one turn item in full), and refuses the rest with t3code's typed errors. A client of the
previous nightly still pairs and works, and a pairing made before this keeps what it could do.
