---
"@sealant/mend": patch
---

A session started per person (`harnessLayout: "person"`, or `MEND_HARNESS_LAYOUT=person`) launches
again. Before, every such launch failed with a server error before its workspace was created,
because Mend asked Sealant about the workspace image with options the SDK refuses, and the session
stayed at `starting` until someone stopped it. If a launch fails while Mend decides the layout, the
session now settles as failed, with the reason on its line.
