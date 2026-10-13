---
"@sealant/mend": patch
---

Phone notifications use a scoped Expo transport with typed response decoding. Interrupting an
in-flight delivery now aborts its HTTP request/body. Malformed successful replies are reported as
delivery failures instead of trusting their unchecked shape; registered devices are not pruned on
those failures. Recipient routing, freshness, baseline suppression and retry policy are unchanged.
