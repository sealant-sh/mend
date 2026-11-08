---
"@sealant/mend": patch
---

A Codex conversation keeps going when Codex reports that it is reconnecting and will retry. Before,
the first such report ended the conversation and cancelled its turns. An error Codex will not retry
still ends it, now with Codex's own words instead of "Codex app-server reported an error."
