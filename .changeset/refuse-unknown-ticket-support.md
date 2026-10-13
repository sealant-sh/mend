---
"@sealant/mend": patch
---

Refuse saved-token socket URL fallback when upgrade-ticket support cannot be established from a
successful health response. Keep compatibility with observed legacy servers and bound health
discovery by cancellation and a five-second deadline.
