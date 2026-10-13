---
"@sealant/mend": patch
---

Use the Effect clock for both Slack connection age and reconnect waits. Keep the existing one-second
ordinary reconnect floor, five-minute token-refusal delay and sixty-second healthy-connection reset.
