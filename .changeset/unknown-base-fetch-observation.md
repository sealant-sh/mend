---
"@sealant/mend": patch
---

Keep the original fetch failure or credential refusal when an unknown base cannot be resolved after
refreshing origin. Say origin was fetched only when that fetch succeeded. A known local base still
starts a session after a best-effort refresh failure.
