---
"@sealant/mend": patch
---

Mend now projects a Codex or Claude conversation's final JSON message when its output ends without a
terminating newline. Previously, the adapters flushed the decoder before reading any output and
discarded that final message. An incomplete line boundary remains unacknowledged for replay.
