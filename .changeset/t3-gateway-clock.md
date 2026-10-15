---
"@sealant/mend": patch
---

The T3 Code gateway reads time through the Effect clock: queue deadlines and retries, event and
terminal timestamps, image and draft ages, device revocations and the event stream's reconnect
backoff. The queue stays on a monotonic clock. Every delay, deadline and retry value is unchanged.
