---
"@sealant/mend": patch
---

The phone's Stop button (the one beside the composer while the agent works) no longer reports a
"JSON Parse error". The server stopped the turn and answered with no body, and the phone tried to
read one.
