---
"@sealant/mend": patch
---

Preserve whitespace and XML/code text when converting Codex and Claude conversations. Recognize
complete Codex environment context separately from actual user input instead of dropping every
message beginning with an angle bracket.
